<?php
session_start();
header('Content-Type: application/json');

// Enable error reporting for debugging
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

// --- CSRF -----------------------------------------------------------------
// One token per session, regenerated only on auth state change.
if (empty($_SESSION['csrf_token'])) {
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}

function require_csrf() {
    $hdr = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!isset($_SESSION['csrf_token']) || !hash_equals($_SESSION['csrf_token'], $hdr)) {
        http_response_code(403);
        echo json_encode(['error' => 'invalid csrf token']);
        exit;
    }
}

// --- WS auth token --------------------------------------------------------
// Mints an HMAC-signed token that the Node WS server verifies on `identify`.
// PHP and Node share the secret via the WS_SECRET environment variable on
// both Bluehost and Railway. Without it, falls back to a non-HMAC marker so
// the system still works during the rollout — set WS_SECRET in both places.
function mint_ws_token($nickname, $ttlSeconds = 86400) {
    $payload = json_encode(['nickname' => $nickname, 'exp' => time() + $ttlSeconds]);
    $b64 = rtrim(strtr(base64_encode($payload), '+/', '-_'), '=');
    $secret = getenv('WS_SECRET');
    $sig = $secret ? hash_hmac('sha256', $b64, $secret) : 'dev';
    return "$b64.$sig";
}

// Database setup
$dbFile = __DIR__ . '/chatrooms.db';
$dbDir = __DIR__;
$isNewDb = !file_exists($dbFile);

// Ensure the directory is writable
if (!is_writable($dbDir)) {
    http_response_code(500);
    echo json_encode(['error' => 'Directory is not writable: ' . $dbDir]);
    exit;
}

try {
    $db = new PDO('sqlite:' . $dbFile);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    
    // Create tables if this is a new database
    if ($isNewDb) {
        $db->exec('
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL,
                user_nickname TEXT NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (room_id) REFERENCES rooms(id)
            );
        ');
        
        // Add some default rooms
        $stmt = $db->prepare('INSERT INTO rooms (name) VALUES (:name)');
        $defaultRooms = ['Main Lobby', 'Tech Talk', 'Gaming Zone', 'Movies & TV'];
        foreach ($defaultRooms as $roomName) {
            $stmt->execute(['name' => $roomName]);
        }
    }
    
    // Handle API requests
    $endpoint = isset($_GET['endpoint']) ? $_GET['endpoint'] : 'unknown';
    
    // Check if user is logged in for protected endpoints
    $protectedEndpoints = ['create-room', 'get-messages', 'save-message', 'active-users'];
    if (in_array($endpoint, $protectedEndpoints)) {
        error_log('Protected endpoint requested: ' . $endpoint);
        error_log('Session data: ' . print_r($_SESSION, true));
        
        if (!isset($_SESSION['user'])) {
            error_log('User not authenticated');
            http_response_code(401);
            echo json_encode(['error' => 'Authentication required']);
            exit;
        }
        error_log('User authenticated: ' . $_SESSION['user']['username']);
    }
    
    switch ($endpoint) {
        case 'login':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_csrf();

            $data = json_decode(file_get_contents('php://input'), true);
            $username = $data['username'] ?? '';
            $password = $data['password'] ?? '';

            if (empty($username) || empty($password)) {
                http_response_code(400);
                echo json_encode(['error' => 'Username and password are required']);
                break;
            }

            $stmt = $db->prepare('SELECT id, username, password FROM users WHERE username = :username');
            $stmt->execute(['username' => $username]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);

            $valid = false;
            if ($row) {
                $stored = $row['password'];
                if (strncmp($stored, '$2', 2) === 0) {
                    // bcrypt
                    $valid = password_verify($password, $stored);
                } elseif (hash_equals($stored, hash('sha256', $password))) {
                    // Legacy SHA-256 — accept once, then upgrade in place.
                    $valid = true;
                    $newHash = password_hash($password, PASSWORD_BCRYPT);
                    $upd = $db->prepare('UPDATE users SET password = :pw WHERE id = :id');
                    $upd->execute(['pw' => $newHash, 'id' => $row['id']]);
                }
            }

            if (!$valid) {
                http_response_code(401);
                echo json_encode(['error' => 'Invalid username or password']);
                break;
            }

            $user = ['id' => $row['id'], 'username' => $row['username']];
            $_SESSION['user'] = $user;
            $_SESSION['nickname'] = $user['username'];
            // Rotate CSRF on auth state change to prevent fixation.
            $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
            echo json_encode([
                'success' => true,
                'user' => $user,
                'csrf_token' => $_SESSION['csrf_token'],
                'ws_token' => mint_ws_token($user['username']),
            ]);
            break;
            
        case 'register':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_csrf();

            $data = json_decode(file_get_contents('php://input'), true);
            $username = $data['username'] ?? '';
            $password = $data['password'] ?? '';

            if (empty($username) || empty($password)) {
                http_response_code(400);
                echo json_encode(['error' => 'Username and password are required']);
                break;
            }

            $stmt = $db->prepare('SELECT id FROM users WHERE username = :username');
            $stmt->execute(['username' => $username]);
            if ($stmt->fetch()) {
                http_response_code(409);
                echo json_encode(['error' => 'Username already exists']);
                break;
            }

            $stmt = $db->prepare('INSERT INTO users (username, password) VALUES (:username, :password)');
            try {
                $stmt->execute([
                    'username' => $username,
                    'password' => password_hash($password, PASSWORD_BCRYPT),
                ]);

                $user = ['id' => $db->lastInsertId(), 'username' => $username];
                $_SESSION['user'] = $user;
                $_SESSION['nickname'] = $username;
                $_SESSION['csrf_token'] = bin2hex(random_bytes(32));

                echo json_encode([
                    'success' => true,
                    'user' => $user,
                    'csrf_token' => $_SESSION['csrf_token'],
                    'ws_token' => mint_ws_token($username),
                ]);
            } catch (PDOException $e) {
                http_response_code(500);
                echo json_encode(['error' => 'Failed to create user']);
            }
            break;
            
        case 'rooms':
            // Get all rooms
            $stmt = $db->query('SELECT id, name, created_at FROM rooms ORDER BY created_at DESC');
            $rooms = $stmt->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'rooms' => $rooms]);
            break;
            
        case 'active-users':
            error_log('Active users request received');
            // Get all active users - include ALL users created in last 30 minutes regardless of activity
            $stmt = $db->prepare('
                SELECT DISTINCT u.username as user_nickname,
                       COALESCE(
                           (SELECT MAX(timestamp) 
                            FROM messages 
                            WHERE user_nickname = u.username),
                           u.created_at
                       ) as last_active
                FROM users u
                WHERE u.created_at >= datetime("now", "-30 minutes")
                OR EXISTS (
                    SELECT 1 
                    FROM messages m 
                    WHERE m.user_nickname = u.username 
                    AND m.timestamp >= datetime("now", "-5 minutes")
                )
                ORDER BY last_active DESC
            ');
            $stmt->execute();
            $users = $stmt->fetchAll(PDO::FETCH_ASSOC);
            error_log('Found users: ' . print_r($users, true));
            
            // Add the current user if not in the list
            $currentUserFound = false;
            foreach ($users as $user) {
                if ($user['user_nickname'] === $_SESSION['user']['username']) {
                    $currentUserFound = true;
                    break;
                }
            }
            
            if (!$currentUserFound) {
                error_log('Adding current user to active users list');
                $users[] = [
                    'user_nickname' => $_SESSION['user']['username'],
                    'last_active' => date('Y-m-d H:i:s'),
                    'status' => 'online'
                ];
            }
            
            // Format the response
            $formattedUsers = array_map(function($user) {
                return [
                    'nickname' => $user['user_nickname'],
                    'status' => 'online',
                    'avatarColor' => '#' . substr(md5($user['user_nickname']), 0, 6),
                    'lastActive' => $user['last_active']
                ];
            }, $users);
            
            $response = ['success' => true, 'users' => $formattedUsers];
            error_log('Sending response: ' . json_encode($response));
            echo json_encode($response);
            break;
            
        case 'create-room':
            // Create a new room
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                error_log('Method not allowed: ' . $_SERVER['REQUEST_METHOD']);
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_csrf();

            error_log('Received create-room request');
            $data = json_decode(file_get_contents('php://input'), true);
            error_log('Request data: ' . print_r($data, true));
            
            $roomName = isset($data['name']) ? htmlspecialchars(strip_tags(trim($data['name']))) : '';
            error_log('Room name after sanitization: ' . $roomName);
            
            if (empty($roomName)) {
                error_log('Room name is empty');
                http_response_code(400);
                echo json_encode(['error' => 'Room name is required']);
                break;
            }
            
            try {
                error_log('Attempting to insert room into database');
                $stmt = $db->prepare('INSERT INTO rooms (name) VALUES (:name)');
                $stmt->execute(['name' => $roomName]);
                $roomId = $db->lastInsertId();
                error_log('Room created successfully with ID: ' . $roomId);
                
                $response = [
                    'success' => true,
                    'room' => [
                        // lastInsertId() returns a string; cast to int so it
                        // matches the type the rooms-list endpoint returns
                        // (SELECT). Mismatched types put clients in different
                        // server-side room buckets and break message fan-out.
                        'id' => (int)$roomId,
                        'name' => $roomName,
                        'created_at' => date('Y-m-d H:i:s')
                    ]
                ];
                error_log('Sending response: ' . print_r($response, true));
                echo json_encode($response);
            } catch (Exception $e) {
                error_log('Failed to create room: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to create room: ' . $e->getMessage()]);
            }
            break;
            
        case 'get-messages':
            // Get messages for a specific room
            if (!isset($_GET['room_id'])) {
                http_response_code(400);
                echo json_encode(['error' => 'Room ID is required']);
                break;
            }
            
            $roomId = (int)$_GET['room_id'];
            
            // Check if we need to paginate (for loading more history)
            $before = isset($_GET['before']) ? $_GET['before'] : null;
            $limit = isset($_GET['limit']) ? min((int)$_GET['limit'], 100) : 50; // Limit to 100 max messages per request
            
            if ($before) {
                // Load messages before a specific timestamp (for pagination)
                $stmt = $db->prepare('
                    SELECT id, user_nickname, message, timestamp 
                    FROM messages 
                    WHERE room_id = :room_id AND timestamp < :before
                    ORDER BY timestamp DESC
                    LIMIT :limit
                ');
                $stmt->bindParam(':room_id', $roomId, PDO::PARAM_INT);
                $stmt->bindParam(':before', $before);
                $stmt->bindParam(':limit', $limit, PDO::PARAM_INT);
            } else {
                // Load most recent messages
                $stmt = $db->prepare('
                    SELECT id, user_nickname, message, timestamp 
                    FROM messages 
                    WHERE room_id = :room_id 
                    ORDER BY timestamp DESC
                    LIMIT :limit
                ');
                $stmt->bindParam(':room_id', $roomId, PDO::PARAM_INT);
                $stmt->bindParam(':limit', $limit, PDO::PARAM_INT);
            }
            
            $stmt->execute();
            $messages = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            // Reverse the messages to show them in chronological order
            $messages = array_reverse($messages);
            
            // Check if there are more messages to load
            $hasMore = false;
            if (count($messages) > 0) {
                $oldestMessage = $messages[0];
                $stmt = $db->prepare('
                    SELECT COUNT(*) as count
                    FROM messages
                    WHERE room_id = :room_id AND timestamp < :oldest_timestamp
                ');
                $stmt->execute([
                    'room_id' => $roomId,
                    'oldest_timestamp' => $oldestMessage['timestamp']
                ]);
                $result = $stmt->fetch(PDO::FETCH_ASSOC);
                $hasMore = $result['count'] > 0;
            }
            
            echo json_encode([
                'success' => true, 
                'messages' => $messages,
                'has_more' => $hasMore,
                'oldest_timestamp' => count($messages) > 0 ? $messages[0]['timestamp'] : null
            ]);
            break;
            
        case 'save-message':
            // Save a message to the database (fallback if WebSockets fail)
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_csrf();

            $data = json_decode(file_get_contents('php://input'), true);
            $roomId = isset($data['room_id']) ? filter_var($data['room_id'], FILTER_SANITIZE_NUMBER_INT) : 0;
            $message = '';
            if (isset($data['message'])) {
                // FILTER_SANITIZE_STRING is deprecated in PHP 8.1+, using alternative
                $message = htmlspecialchars(strip_tags(trim($data['message'])));
            }
            $nickname = $_SESSION['nickname'];
            
            if (empty($roomId) || empty($message)) {
                http_response_code(400);
                echo json_encode(['error' => 'Room ID and message are required']);
                break;
            }
            
            $stmt = $db->prepare('
                INSERT INTO messages (room_id, user_nickname, message) 
                VALUES (:room_id, :user_nickname, :message)
            ');
            $stmt->execute([
                'room_id' => $roomId,
                'user_nickname' => $nickname,
                'message' => $message
            ]);
            
            echo json_encode([
                'success' => true,
                'message' => [
                    'id' => $db->lastInsertId(),
                    'room_id' => $roomId,
                    'user_nickname' => $nickname,
                    'message' => $message,
                    'timestamp' => date('Y-m-d H:i:s')
                ]
            ]);
            break;
            
        default:
            http_response_code(404);
            echo json_encode(['error' => 'Endpoint not found']);
            break;
    }
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Database error: ' . $e->getMessage()]);
}
?>