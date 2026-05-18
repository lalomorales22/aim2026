<?php
// Load WS_SECRET (and any other env vars) before mint_ws_token() runs.
// Mirrors the include in index.php so we don't rely on .user.ini alone.
if (is_readable(__DIR__ . '/.aim-env.php')) {
    require_once __DIR__ . '/.aim-env.php';
}

session_start();
header('Content-Type: application/json');

// Debug-mode error reporting — gated behind an env var so prod stays quiet.
// Set `putenv('AIM_DEBUG=1')` in .aim-env.php (or the equivalent on Railway)
// while troubleshooting; unset it for normal operation. error_reporting is
// still E_ALL so logs capture everything; only the JSON-corrupting display
// path is toggled.
$AIM_DEBUG = getenv('AIM_DEBUG') === '1';
ini_set('display_errors',        $AIM_DEBUG ? 1 : 0);
ini_set('display_startup_errors', $AIM_DEBUG ? 1 : 0);
error_reporting(E_ALL);

// Small helper so we can sprinkle debug breadcrumbs without bloating error_log
// in normal operation. Use error_log() directly for things that should always
// be logged (auth failures, DB exceptions); use aim_debug() for trace noise.
function aim_debug($msg) {
    if (getenv('AIM_DEBUG') === '1') {
        error_log($msg);
    }
}

// Normalize any timestamp emitted to clients into ISO 8601 with explicit UTC
// (Z suffix). SQLite's TIMESTAMP DEFAULT CURRENT_TIMESTAMP stores UTC but
// emits "YYYY-MM-DD HH:MM:SS" — that string has no timezone marker, so
// JavaScript's `new Date(s)` treats it as the BROWSER'S local time. East-
// coast users would see all timestamps shifted by their UTC offset.
// Marking with Z makes the parse unambiguous so getHours() / toLocaleString
// produces the user's correct local clock time. (Server-side WS timestamps
// already use new Date().toISOString(), which is fine.)
function aim_iso_utc($t = null) {
    if ($t === null) return gmdate('Y-m-d\TH:i:s\Z');
    if ($t === '' || $t === false) return $t;
    // Already-ISO strings pass through (Z suffix or a 'T' separator means
    // someone upstream already marked it).
    if (substr($t, -1) === 'Z' || strpos($t, 'T') !== false) return $t;
    $ts = strtotime($t . ' UTC');
    if ($ts === false) return $t;  // unrecognized format — return as-is
    return gmdate('Y-m-d\TH:i:s\Z', $ts);
}

// Inverse of aim_iso_utc — converts an ISO 8601 string back to SQLite's
// "YYYY-MM-DD HH:MM:SS" format. Needed for pagination cursors: the client
// sends back a timestamp we previously emitted (now in ISO/Z form), but
// SQLite's `timestamp < :before` is a lexicographic string compare against
// rows stored in the old space-separated format. Without normalizing the
// cursor, 'T'(0x54) > ' '(0x20) makes ISO strings sort AFTER all SQLite
// rows, so pagination over-fetches.
function aim_sql_ts($t) {
    if (!$t) return $t;
    $ts = strtotime($t);
    if ($ts === false) return $t;
    return gmdate('Y-m-d H:i:s', $ts);
}

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

// --- Moderation -----------------------------------------------------------
// Admin is hard-coded by username — only this account can delete rooms via
// the moderation endpoint. Keeping the check here (server-side) means a
// tampered client can't grant itself the button.
const ADMIN_USERNAME = 'lalopenguin';
function is_admin($username) {
    return $username === ADMIN_USERNAME;
}

// Rejects chatroom names that contain slurs. Normalizes whitespace,
// punctuation, and common leet-speak substitutions, then substring-matches
// against a small banned list. Conservative on purpose — a few false
// positives are preferable to letting slurs through.
function is_bad_room_name($name) {
    $n = strtolower($name);
    $n = strtr($n, [
        '0' => 'o', '1' => 'i', '!' => 'i', '|' => 'i',
        '3' => 'e', '4' => 'a', '@' => 'a',
        '5' => 's', '$' => 's', '7' => 't', '8' => 'b',
    ]);
    // Strip anything that isn't a-z so spaced-out slurs ("n i g") collapse.
    $n = preg_replace('/[^a-z]/', '', $n);
    $banned = [
        'nigger', 'nigga', 'niggr', 'nigro',
        'faggot', 'fagot',
        'kike',
        'chink',
        'spic', 'wetback',
        'gook',
        'coon',
        'tranny',
        'retard',
    ];
    foreach ($banned as $word) {
        if (strpos($n, $word) !== false) return true;
    }
    return false;
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

// --- Buddy icon validation ------------------------------------------------
// Phase 3.2 — avatar_icon is stored as a base64 data URL. Validate format
// + magic bytes + size before accepting it into the profile. Returns the
// data URL if valid, the empty string if cleared, or false if invalid.
function aim_validate_avatar_icon($dataUrl) {
    if ($dataUrl === null || $dataUrl === '') return '';
    if (!is_string($dataUrl)) return false;
    if (!preg_match('#^data:image/(png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$#', $dataUrl, $m)) {
        return false;
    }
    $decoded = base64_decode($m[2], true);
    if ($decoded === false) return false;
    // 32 KB raw is plenty for a 64x64 PNG. Larger -> reject.
    if (strlen($decoded) > 32 * 1024) return false;
    // Magic-byte sniff so a malicious client can't put HTML behind a PNG
    // MIME type and have us echo it back into someone else's profile page.
    $type = $m[1];
    if ($type === 'png'  && substr($decoded, 0, 8) !== "\x89PNG\r\n\x1a\n") return false;
    if ($type === 'jpeg' && substr($decoded, 0, 3) !== "\xff\xd8\xff")       return false;
    if ($type === 'gif'
        && substr($decoded, 0, 6) !== 'GIF89a'
        && substr($decoded, 0, 6) !== 'GIF87a') return false;
    return $dataUrl;
}

// --- Internal service auth ------------------------------------------------
// Railway calls a handful of backend.php endpoints (save-dm) to persist data
// it received over WebSocket. Those calls can't have a PHP session or CSRF
// token, so they authenticate via a shared secret in the X-Internal-Token
// header. BACKEND_API_TOKEN must be set on BOTH Bluehost (.aim-env.php) and
// Railway (env var). If not set on Bluehost, the endpoint rejects all
// requests — fail closed rather than fail open.
function require_internal_token() {
    $token = getenv('BACKEND_API_TOKEN');
    if (!$token) {
        http_response_code(503);
        echo json_encode(['error' => 'internal auth not configured']);
        error_log('BACKEND_API_TOKEN not set — refusing internal request');
        exit;
    }
    $hdr = $_SERVER['HTTP_X_INTERNAL_TOKEN'] ?? '';
    if (!hash_equals($token, $hdr)) {
        http_response_code(403);
        echo json_encode(['error' => 'invalid internal token']);
        exit;
    }
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

    // Buddies table — created lazily (IF NOT EXISTS) so existing deployments
    // get the table on first hit without a separate migration step.
    // (owner, buddy_nickname) is unique so add-buddy is idempotent.
    $db->exec("
        CREATE TABLE IF NOT EXISTS buddies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            buddy_nickname TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(owner, buddy_nickname)
        );
    ");

    // Phase 1 schema additions — all CREATE IF NOT EXISTS so they're safe to
    // run against the live chatrooms.db on Bluehost. See tasks.md Phase 1.3/1.4.
    //
    // dm_messages: persistent DM history. Today DMs live in Railway memory and
    // die on redeploy; persisting them here means history survives restarts.
    // message_type lets future game-invite and game-result entries ride the
    // same DM stream without a separate table.
    $db->exec("
        CREATE TABLE IF NOT EXISTS dm_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender TEXT NOT NULL,
            recipient TEXT NOT NULL,
            message TEXT NOT NULL,
            message_type TEXT NOT NULL DEFAULT 'text',
            payload TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dm_pair_time
            ON dm_messages(sender, recipient, timestamp);
        CREATE INDEX IF NOT EXISTS idx_dm_recipient_time
            ON dm_messages(recipient, timestamp);
    ");

    // profiles: server-backed user profile so settings follow the user across
    // devices / browsers instead of living in per-browser localStorage. The
    // away_message / avatar_icon / sound_pack columns are reserved for Phase
    // 3 features but the column is cheap to add now.
    $db->exec("
        CREATE TABLE IF NOT EXISTS profiles (
            username TEXT PRIMARY KEY,
            display_name TEXT,
            bio TEXT,
            avatar_color TEXT,
            avatar_icon TEXT,
            away_message TEXT,
            status TEXT,
            sound_pack TEXT,
            sound_enabled INTEGER DEFAULT 1,
            typing_indicator INTEGER DEFAULT 1,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    ");

    // game_results: per-game win/loss/draw rows. Phase 2 will write to this;
    // get-stats reads from it. Created now so the table exists when Phase 2
    // ships and stats queries work the moment the first game ends.
    $db->exec("
        CREATE TABLE IF NOT EXISTS game_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_type TEXT NOT NULL,
            player_a TEXT NOT NULL,
            player_b TEXT NOT NULL,
            winner TEXT,
            played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            duration_seconds INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_results_players
            ON game_results(player_a, player_b);
        CREATE INDEX IF NOT EXISTS idx_results_type_winner
            ON game_results(game_type, winner);
    ");

    // Phase 3.8 — Mail "last seen" timestamp on profiles. SQLite has no
    // "ADD COLUMN IF NOT EXISTS", so try and swallow the specific dup-column
    // error. Anything else bubbles up.
    try {
        $db->exec("ALTER TABLE profiles ADD COLUMN mail_last_seen_at TIMESTAMP");
    } catch (PDOException $e) {
        if (strpos($e->getMessage(), 'duplicate column') === false) {
            throw $e;
        }
    }
    
    // Ensure the admin account exists AND its password matches the value
    // configured in .aim-env.php. If the row was pre-existing with a stale
    // password, this resets it to the current ADMIN_PASSWORD. Skipped
    // entirely when ADMIN_PASSWORD is unset (no .aim-env.php yet, etc).
    $adminPw = getenv('ADMIN_PASSWORD');
    if ($adminPw) {
        $adminCheck = $db->prepare('SELECT id, password FROM users WHERE username = :u');
        $adminCheck->execute(['u' => ADMIN_USERNAME]);
        $adminRow = $adminCheck->fetch(PDO::FETCH_ASSOC);

        if (!$adminRow) {
            $insertAdmin = $db->prepare('INSERT INTO users (username, password) VALUES (:u, :p)');
            $insertAdmin->execute([
                'u' => ADMIN_USERNAME,
                'p' => password_hash($adminPw, PASSWORD_BCRYPT),
            ]);
        } elseif (!password_verify($adminPw, $adminRow['password'])) {
            $updateAdmin = $db->prepare('UPDATE users SET password = :p WHERE id = :id');
            $updateAdmin->execute([
                'p'  => password_hash($adminPw, PASSWORD_BCRYPT),
                'id' => $adminRow['id'],
            ]);
        }
    }

    // Handle API requests
    $endpoint = isset($_GET['endpoint']) ? $_GET['endpoint'] : 'unknown';

    // Check if user is logged in for protected endpoints
    $protectedEndpoints = ['create-room', 'delete-room', 'get-messages', 'save-message', 'active-users', 'buddies', 'add-buddy', 'remove-buddy', 'save-profile', 'get-stats', 'get-unread-dms', 'mark-mail-seen', 'get-leaderboard'];
    if (in_array($endpoint, $protectedEndpoints)) {
        aim_debug('Protected endpoint requested: ' . $endpoint);
        aim_debug('Session data: ' . print_r($_SESSION, true));

        if (!isset($_SESSION['user'])) {
            error_log('User not authenticated on protected endpoint: ' . $endpoint);
            http_response_code(401);
            echo json_encode(['error' => 'Authentication required']);
            exit;
        }
        aim_debug('User authenticated: ' . $_SESSION['user']['username']);
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
            // Get all rooms — hidden Easter-egg rooms (Phase 4.8) are
            // excluded so they only show up to users who type the name
            // exactly in the Create Room dialog.
            $stmt = $db->query("
                SELECT id, name, created_at FROM rooms
                WHERE LOWER(name) NOT IN ('the 90s')
                ORDER BY created_at DESC
            ");
            $rooms = $stmt->fetchAll(PDO::FETCH_ASSOC);
            foreach ($rooms as &$r) { $r['created_at'] = aim_iso_utc($r['created_at']); }
            unset($r);
            echo json_encode(['success' => true, 'rooms' => $rooms]);
            break;
            
        case 'active-users':
            aim_debug('Active users request received');
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
            aim_debug('Found users: ' . print_r($users, true));
            
            // Add the current user if not in the list
            $currentUserFound = false;
            foreach ($users as $user) {
                if ($user['user_nickname'] === $_SESSION['user']['username']) {
                    $currentUserFound = true;
                    break;
                }
            }
            
            if (!$currentUserFound) {
                aim_debug('Adding current user to active users list');
                $users[] = [
                    'user_nickname' => $_SESSION['user']['username'],
                    'last_active' => aim_iso_utc(),
                    'status' => 'online'
                ];
            }

            // Format the response. Timestamps go through aim_iso_utc so the
            // client's `new Date(ts)` parses them as UTC and displays local.
            $formattedUsers = array_map(function($user) {
                return [
                    'nickname' => $user['user_nickname'],
                    'status' => 'online',
                    'avatarColor' => '#' . substr(md5($user['user_nickname']), 0, 6),
                    'lastActive' => aim_iso_utc($user['last_active']),
                ];
            }, $users);
            
            $response = ['success' => true, 'users' => $formattedUsers];
            aim_debug('Sending active-users response: ' . json_encode($response));
            echo json_encode($response);
            break;
            
        case 'create-room':
            // Create a new room
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_csrf();

            $data = json_decode(file_get_contents('php://input'), true);
            aim_debug('create-room request data: ' . print_r($data, true));

            $roomName = isset($data['name']) ? htmlspecialchars(strip_tags(trim($data['name']))) : '';

            if (empty($roomName)) {
                http_response_code(400);
                echo json_encode(['error' => 'Room name is required']);
                break;
            }

            if (is_bad_room_name($roomName)) {
                error_log('Room name rejected by moderation filter: ' . $roomName);
                http_response_code(400);
                echo json_encode(['error' => 'That room name is not allowed.']);
                break;
            }

            try {
                // De-dupe by case-insensitive exact match — same room
                // doesn't get two listings. Also makes the hidden room
                // "The 90s" reachable: typing the exact name (Phase 4.8)
                // joins the existing one instead of creating a duplicate.
                $check = $db->prepare('SELECT id, name, created_at FROM rooms WHERE LOWER(name) = LOWER(:n) LIMIT 1');
                $check->execute(['n' => $roomName]);
                $existing = $check->fetch(PDO::FETCH_ASSOC);
                if ($existing) {
                    echo json_encode([
                        'success' => true,
                        'room' => [
                            'id' => (int)$existing['id'],
                            'name' => $existing['name'],
                            'created_at' => aim_iso_utc($existing['created_at']),
                        ],
                    ]);
                    break;
                }

                $stmt = $db->prepare('INSERT INTO rooms (name) VALUES (:name)');
                $stmt->execute(['name' => $roomName]);
                $roomId = $db->lastInsertId();
                aim_debug('Room created with ID: ' . $roomId);

                $response = [
                    'success' => true,
                    'room' => [
                        // lastInsertId() returns a string; cast to int so it
                        // matches the type the rooms-list endpoint returns
                        // (SELECT). Mismatched types put clients in different
                        // server-side room buckets and break message fan-out.
                        'id' => (int)$roomId,
                        'name' => $roomName,
                        'created_at' => aim_iso_utc(),
                    ]
                ];
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

            // Check if we need to paginate (for loading more history).
            // Normalize the cursor back to SQLite format so the WHERE clause
            // string-compares against actual stored rows.
            $before = isset($_GET['before']) ? aim_sql_ts($_GET['before']) : null;
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

            // Check if there are more messages to load (use the still-SQLite
            // oldest timestamp for the compare, BEFORE we ISO-ify it).
            $rawOldest = count($messages) > 0 ? $messages[0]['timestamp'] : null;
            $hasMore = false;
            if ($rawOldest) {
                $stmt = $db->prepare('
                    SELECT COUNT(*) as count
                    FROM messages
                    WHERE room_id = :room_id AND timestamp < :oldest_timestamp
                ');
                $stmt->execute([
                    'room_id' => $roomId,
                    'oldest_timestamp' => $rawOldest,
                ]);
                $result = $stmt->fetch(PDO::FETCH_ASSOC);
                $hasMore = $result['count'] > 0;
            }

            // Now normalize all emitted timestamps to ISO UTC so the
            // browser's `new Date(...)` parses them unambiguously.
            foreach ($messages as &$m) {
                $m['timestamp'] = aim_iso_utc($m['timestamp']);
            }
            unset($m);

            echo json_encode([
                'success' => true,
                'messages' => $messages,
                'has_more' => $hasMore,
                'oldest_timestamp' => aim_iso_utc($rawOldest),
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
                    'timestamp' => aim_iso_utc(),
                ]
            ]);
            break;
            
        case 'delete-room':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_csrf();

            if (!is_admin($_SESSION['user']['username'])) {
                http_response_code(403);
                echo json_encode(['error' => 'Admin only']);
                break;
            }

            $data = json_decode(file_get_contents('php://input'), true);
            $roomId = isset($data['room_id']) ? (int)$data['room_id'] : 0;
            if ($roomId <= 0) {
                http_response_code(400);
                echo json_encode(['error' => 'room_id is required']);
                break;
            }

            try {
                $db->beginTransaction();
                $delMsgs = $db->prepare('DELETE FROM messages WHERE room_id = :id');
                $delMsgs->execute(['id' => $roomId]);
                $msgRows = $delMsgs->rowCount();

                $delRoom = $db->prepare('DELETE FROM rooms WHERE id = :id');
                $delRoom->execute(['id' => $roomId]);
                $roomRows = $delRoom->rowCount();
                $db->commit();

                echo json_encode([
                    'success' => true,
                    'deleted_room_id' => $roomId,
                    'deleted_messages' => $msgRows,
                    'deleted_rooms' => $roomRows,
                ]);
            } catch (PDOException $e) {
                if ($db->inTransaction()) $db->rollBack();
                http_response_code(500);
                echo json_encode(['error' => 'Failed to delete room: ' . $e->getMessage()]);
            }
            break;

        case 'buddies':
            // List the current user's buddies (GET-safe, no CSRF needed).
            $owner = $_SESSION['user']['username'];
            $stmt = $db->prepare('SELECT buddy_nickname FROM buddies WHERE owner = :o ORDER BY buddy_nickname COLLATE NOCASE');
            $stmt->execute(['o' => $owner]);
            $buddies = array_map(fn($r) => $r['buddy_nickname'], $stmt->fetchAll(PDO::FETCH_ASSOC));
            echo json_encode(['success' => true, 'buddies' => $buddies]);
            break;

        case 'add-buddy':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_csrf();
            $data = json_decode(file_get_contents('php://input'), true);
            $nick = isset($data['nickname']) ? trim($data['nickname']) : '';
            $owner = $_SESSION['user']['username'];
            // Validation: non-empty, not yourself, reasonable length, no funky chars.
            if ($nick === '') {
                http_response_code(400);
                echo json_encode(['error' => 'nickname is required']);
                break;
            }
            if (mb_strlen($nick) > 64) {
                http_response_code(400);
                echo json_encode(['error' => 'nickname too long']);
                break;
            }
            if (strcasecmp($nick, $owner) === 0) {
                http_response_code(400);
                echo json_encode(['error' => "You can't add yourself."]);
                break;
            }
            try {
                $stmt = $db->prepare('INSERT OR IGNORE INTO buddies (owner, buddy_nickname) VALUES (:o, :n)');
                $stmt->execute(['o' => $owner, 'n' => $nick]);
                echo json_encode(['success' => true, 'nickname' => $nick]);
            } catch (PDOException $e) {
                http_response_code(500);
                echo json_encode(['error' => 'Failed to add buddy: ' . $e->getMessage()]);
            }
            break;

        case 'remove-buddy':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_csrf();
            $data = json_decode(file_get_contents('php://input'), true);
            $nick = isset($data['nickname']) ? trim($data['nickname']) : '';
            $owner = $_SESSION['user']['username'];
            if ($nick === '') {
                http_response_code(400);
                echo json_encode(['error' => 'nickname is required']);
                break;
            }
            try {
                $stmt = $db->prepare('DELETE FROM buddies WHERE owner = :o AND buddy_nickname = :n');
                $stmt->execute(['o' => $owner, 'n' => $nick]);
                echo json_encode(['success' => true, 'nickname' => $nick, 'removed' => $stmt->rowCount()]);
            } catch (PDOException $e) {
                http_response_code(500);
                echo json_encode(['error' => 'Failed to remove buddy: ' . $e->getMessage()]);
            }
            break;

        // ------------------------------------------------------------------
        // Phase 1: DM persistence + server-backed profiles + game stats
        // ------------------------------------------------------------------

        case 'save-dm':
            // Internal endpoint called by server.js (Railway) after a DM is
            // relayed. Auth is via X-Internal-Token, NOT session — Railway has
            // no PHP session. Body shape mirrors what server.js already builds.
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_internal_token();
            $data = json_decode(file_get_contents('php://input'), true);
            $sender    = isset($data['sender'])    ? trim($data['sender'])    : '';
            $recipient = isset($data['recipient']) ? trim($data['recipient']) : '';
            $message   = isset($data['message'])   ? (string)$data['message'] : '';
            $type      = isset($data['message_type']) ? trim($data['message_type']) : 'text';
            $payload   = isset($data['payload']) ? json_encode($data['payload']) : null;

            if ($sender === '' || $recipient === '') {
                http_response_code(400);
                echo json_encode(['error' => 'sender and recipient are required']);
                break;
            }
            if ($message === '' && $payload === null) {
                http_response_code(400);
                echo json_encode(['error' => 'message or payload is required']);
                break;
            }
            // Conservative length cap so a runaway client can't pile up the DB.
            if (mb_strlen($message) > 4000) {
                $message = mb_substr($message, 0, 4000);
            }

            try {
                $stmt = $db->prepare("
                    INSERT INTO dm_messages (sender, recipient, message, message_type, payload)
                    VALUES (:s, :r, :m, :t, :p)
                ");
                $stmt->execute([
                    's' => $sender, 'r' => $recipient,
                    'm' => $message, 't' => $type, 'p' => $payload,
                ]);
                echo json_encode(['success' => true, 'id' => (int)$db->lastInsertId()]);
            } catch (PDOException $e) {
                error_log('save-dm failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to save DM']);
            }
            break;

        case 'get-dm-history':
            // Read the DM history between the signed-in user and ?with=<nick>.
            // GET, no CSRF needed — but the requester must be logged in and
            // can only ever see their own conversation pairs.
            if (!isset($_SESSION['user'])) {
                http_response_code(401);
                echo json_encode(['error' => 'Authentication required']);
                break;
            }
            $me    = $_SESSION['user']['username'];
            $other = isset($_GET['with']) ? trim($_GET['with']) : '';
            if ($other === '') {
                http_response_code(400);
                echo json_encode(['error' => 'with is required']);
                break;
            }
            $limit  = isset($_GET['limit'])  ? min((int)$_GET['limit'], 200) : 100;
            // Normalize the pagination cursor — see aim_sql_ts() comment.
            $before = isset($_GET['before']) ? aim_sql_ts($_GET['before']) : null;

            try {
                if ($before) {
                    $stmt = $db->prepare("
                        SELECT id, sender, recipient, message, message_type, payload, timestamp
                        FROM dm_messages
                        WHERE ((sender = :me AND recipient = :other)
                            OR (sender = :other AND recipient = :me))
                          AND timestamp < :before
                        ORDER BY timestamp DESC
                        LIMIT :limit
                    ");
                    $stmt->bindParam(':me', $me);
                    $stmt->bindParam(':other', $other);
                    $stmt->bindParam(':before', $before);
                    $stmt->bindParam(':limit', $limit, PDO::PARAM_INT);
                } else {
                    $stmt = $db->prepare("
                        SELECT id, sender, recipient, message, message_type, payload, timestamp
                        FROM dm_messages
                        WHERE (sender = :me AND recipient = :other)
                           OR (sender = :other AND recipient = :me)
                        ORDER BY timestamp DESC
                        LIMIT :limit
                    ");
                    $stmt->bindParam(':me', $me);
                    $stmt->bindParam(':other', $other);
                    $stmt->bindParam(':limit', $limit, PDO::PARAM_INT);
                }
                $stmt->execute();
                $rows = array_reverse($stmt->fetchAll(PDO::FETCH_ASSOC));
                // Decode payload column for non-text messages so callers don't
                // have to double-parse JSON.
                foreach ($rows as &$r) {
                    if (!empty($r['payload'])) {
                        $decoded = json_decode($r['payload'], true);
                        if ($decoded !== null) $r['payload'] = $decoded;
                    } else {
                        unset($r['payload']);
                    }
                }
                unset($r);
                // Pull the SQLite-format oldest before we ISO-ify rows, so
                // the has-more comparison stays valid.
                $rawOldest = count($rows) > 0 ? $rows[0]['timestamp'] : null;
                $hasMore = false;
                if ($rawOldest) {
                    $cnt = $db->prepare("
                        SELECT COUNT(*) AS c FROM dm_messages
                        WHERE ((sender = :me AND recipient = :other)
                            OR (sender = :other AND recipient = :me))
                          AND timestamp < :oldest
                    ");
                    $cnt->execute(['me' => $me, 'other' => $other, 'oldest' => $rawOldest]);
                    $hasMore = (int)$cnt->fetch(PDO::FETCH_ASSOC)['c'] > 0;
                }
                foreach ($rows as &$r) { $r['timestamp'] = aim_iso_utc($r['timestamp']); }
                unset($r);
                echo json_encode([
                    'success'         => true,
                    'with'            => $other,
                    'messages'        => $rows,
                    'has_more'        => $hasMore,
                    'oldest_timestamp' => aim_iso_utc($rawOldest),
                ]);
            } catch (PDOException $e) {
                error_log('get-dm-history failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to load DM history']);
            }
            break;

        case 'get-profile':
            // Anyone signed in can read any profile (it's the AIM "buddy info"
            // window). Returns sensible defaults if the row doesn't exist yet.
            if (!isset($_SESSION['user'])) {
                http_response_code(401);
                echo json_encode(['error' => 'Authentication required']);
                break;
            }
            $username = isset($_GET['username'])
                ? trim($_GET['username'])
                : $_SESSION['user']['username'];
            if ($username === '') {
                http_response_code(400);
                echo json_encode(['error' => 'username is required']);
                break;
            }
            try {
                $stmt = $db->prepare('SELECT * FROM profiles WHERE username = :u');
                $stmt->execute(['u' => $username]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    // Stable default profile — keep keys in sync with
                    // getUserProfile() in script.js.
                    $row = [
                        'username'         => $username,
                        'display_name'     => $username,
                        'bio'              => 'I love chatting in Windows 95 style!',
                        'avatar_color'     => '#007BFF',
                        'avatar_icon'      => null,
                        'away_message'     => null,
                        'status'           => 'online',
                        'sound_pack'       => 'classic',
                        'sound_enabled'    => 1,
                        'typing_indicator' => 1,
                        'updated_at'       => null,
                    ];
                }
                // Cast booleans for nicer JSON.
                $row['sound_enabled']    = (bool)$row['sound_enabled'];
                $row['typing_indicator'] = (bool)$row['typing_indicator'];
                if (isset($row['updated_at']))        $row['updated_at']        = aim_iso_utc($row['updated_at']);
                if (isset($row['mail_last_seen_at'])) $row['mail_last_seen_at'] = aim_iso_utc($row['mail_last_seen_at']);
                echo json_encode(['success' => true, 'profile' => $row]);
            } catch (PDOException $e) {
                error_log('get-profile failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to load profile']);
            }
            break;

        case 'save-profile':
            // Save the signed-in user's own profile. Users can only write
            // their own row — username is taken from the session, never the
            // payload.
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_csrf();
            $data = json_decode(file_get_contents('php://input'), true) ?? [];
            $username = $_SESSION['user']['username'];

            // Whitelist allowed fields so a tampered client can't sneak in
            // columns like 'username' or 'updated_at'.
            $allowed = ['display_name','bio','avatar_color','avatar_icon',
                        'away_message','status','sound_pack',
                        'sound_enabled','typing_indicator'];

            // Pull current row so missing fields stay unchanged.
            $cur = $db->prepare('SELECT * FROM profiles WHERE username = :u');
            $cur->execute(['u' => $username]);
            $existing = $cur->fetch(PDO::FETCH_ASSOC) ?: [];

            $merged = [];
            foreach ($allowed as $f) {
                if (array_key_exists($f, $data)) {
                    $merged[$f] = $data[$f];
                } elseif (array_key_exists($f, $existing)) {
                    $merged[$f] = $existing[$f];
                } else {
                    $merged[$f] = null;
                }
            }
            // Normalize booleans (SQLite stores 0/1).
            $merged['sound_enabled']    = !empty($merged['sound_enabled'])    ? 1 : 0;
            $merged['typing_indicator'] = !empty($merged['typing_indicator']) ? 1 : 0;

            // Light validation on free-text fields. avatar_icon is handled
            // separately because data URLs can legitimately exceed 500 chars
            // and need the magic-byte sniff in aim_validate_avatar_icon.
            foreach (['display_name','bio','away_message','sound_pack','status','avatar_color'] as $f) {
                if (is_string($merged[$f]) && mb_strlen($merged[$f]) > 500) {
                    $merged[$f] = mb_substr($merged[$f], 0, 500);
                }
            }
            // Status enum guard — anything outside the known set falls back
            // to 'online' so the buddy list never sees a weird value.
            if (!in_array($merged['status'], ['online','away','offline','invisible'], true)) {
                $merged['status'] = 'online';
            }
            // Avatar icon: validate or reject the whole save (loud signal so
            // the client knows the upload failed instead of silently dropping).
            if ($merged['avatar_icon'] !== null && $merged['avatar_icon'] !== '') {
                $validated = aim_validate_avatar_icon($merged['avatar_icon']);
                if ($validated === false) {
                    http_response_code(400);
                    echo json_encode(['error' => 'Invalid avatar_icon — must be a base64 PNG/JPEG/GIF data URL ≤ 32 KB']);
                    break;
                }
                $merged['avatar_icon'] = $validated;
            }

            try {
                $stmt = $db->prepare("
                    INSERT INTO profiles
                      (username, display_name, bio, avatar_color, avatar_icon,
                       away_message, status, sound_pack, sound_enabled,
                       typing_indicator, updated_at)
                    VALUES
                      (:username, :display_name, :bio, :avatar_color, :avatar_icon,
                       :away_message, :status, :sound_pack, :sound_enabled,
                       :typing_indicator, CURRENT_TIMESTAMP)
                    ON CONFLICT(username) DO UPDATE SET
                      display_name     = excluded.display_name,
                      bio              = excluded.bio,
                      avatar_color     = excluded.avatar_color,
                      avatar_icon      = excluded.avatar_icon,
                      away_message     = excluded.away_message,
                      status           = excluded.status,
                      sound_pack       = excluded.sound_pack,
                      sound_enabled    = excluded.sound_enabled,
                      typing_indicator = excluded.typing_indicator,
                      updated_at       = CURRENT_TIMESTAMP
                ");
                $stmt->execute([
                    'username'         => $username,
                    'display_name'     => $merged['display_name'],
                    'bio'              => $merged['bio'],
                    'avatar_color'     => $merged['avatar_color'],
                    'avatar_icon'      => $merged['avatar_icon'],
                    'away_message'     => $merged['away_message'],
                    'status'           => $merged['status'],
                    'sound_pack'       => $merged['sound_pack'],
                    'sound_enabled'    => $merged['sound_enabled'],
                    'typing_indicator' => $merged['typing_indicator'],
                ]);
                echo json_encode(['success' => true, 'profile' => array_merge(
                    ['username' => $username],
                    $merged,
                    ['sound_enabled' => (bool)$merged['sound_enabled'],
                     'typing_indicator' => (bool)$merged['typing_indicator']]
                )]);
            } catch (PDOException $e) {
                error_log('save-profile failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to save profile']);
            }
            break;

        case 'save-game-result':
            // Internal endpoint called by server.js (Railway) when a game
            // ends. Inserts into game_results so get-stats can aggregate.
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            require_internal_token();
            $data = json_decode(file_get_contents('php://input'), true);
            $type   = isset($data['game_type']) ? trim($data['game_type']) : '';
            $a      = isset($data['player_a']) ? trim($data['player_a']) : '';
            $b      = isset($data['player_b']) ? trim($data['player_b']) : '';
            $winner = isset($data['winner']) && $data['winner'] !== '' ? trim($data['winner']) : null;
            $dur    = isset($data['duration_seconds']) ? (int)$data['duration_seconds'] : null;

            if ($type === '' || $a === '' || $b === '') {
                http_response_code(400);
                echo json_encode(['error' => 'game_type, player_a, player_b are required']);
                break;
            }
            // Winner (if set) must actually be one of the two players —
            // catches any client-side bug where the wrong nickname leaks in.
            if ($winner !== null && $winner !== $a && $winner !== $b) {
                http_response_code(400);
                echo json_encode(['error' => 'winner must be one of the players or null']);
                break;
            }

            try {
                $stmt = $db->prepare("
                    INSERT INTO game_results
                      (game_type, player_a, player_b, winner, duration_seconds)
                    VALUES
                      (:t, :a, :b, :w, :d)
                ");
                $stmt->execute([
                    't' => $type, 'a' => $a, 'b' => $b,
                    'w' => $winner, 'd' => $dur,
                ]);
                echo json_encode(['success' => true, 'id' => (int)$db->lastInsertId()]);
            } catch (PDOException $e) {
                error_log('save-game-result failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to save game result']);
            }
            break;

        case 'get-stats':
            // W/L/D aggregate for one user, grouped by game_type. Backs the
            // stats panel that Phase 2 will hang in the profile window.
            $username = isset($_GET['username'])
                ? trim($_GET['username'])
                : $_SESSION['user']['username'];
            if ($username === '') {
                http_response_code(400);
                echo json_encode(['error' => 'username is required']);
                break;
            }
            try {
                $stmt = $db->prepare("
                    SELECT game_type,
                           SUM(CASE WHEN winner = :u THEN 1 ELSE 0 END) AS wins,
                           SUM(CASE WHEN winner IS NOT NULL AND winner != :u THEN 1 ELSE 0 END) AS losses,
                           SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END) AS draws
                    FROM game_results
                    WHERE player_a = :u OR player_b = :u
                    GROUP BY game_type
                ");
                $stmt->execute(['u' => $username]);
                $stats = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($stats as &$s) {
                    $s['wins']   = (int)$s['wins'];
                    $s['losses'] = (int)$s['losses'];
                    $s['draws']  = (int)$s['draws'];
                }
                unset($s);
                echo json_encode(['success' => true, 'username' => $username, 'stats' => $stats]);
            } catch (PDOException $e) {
                error_log('get-stats failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to load stats']);
            }
            break;

        case 'get-leaderboard':
            // Phase 4.4 — Top players for a single game_type. Returns up to
            // ?limit (default 10) rows ordered by wins desc, then win pct.
            // We require at least 1 game played to filter out rows that
            // would be all zeroes from a profile created but never played.
            $gameType = isset($_GET['game_type']) ? trim($_GET['game_type']) : '';
            $limit    = isset($_GET['limit'])
                ? max(1, min(50, (int)$_GET['limit']))
                : 10;
            if ($gameType === '') {
                http_response_code(400);
                echo json_encode(['error' => 'game_type is required']);
                break;
            }
            try {
                // Aggregate W/L/D per player across player_a / player_b
                // columns. The "player" in the UNION is whichever side
                // the row's player_a/player_b matches per iteration.
                $stmt = $db->prepare("
                    WITH played AS (
                        SELECT player_a AS player, winner FROM game_results
                        WHERE game_type = :gt
                        UNION ALL
                        SELECT player_b AS player, winner FROM game_results
                        WHERE game_type = :gt
                    )
                    SELECT player,
                           SUM(CASE WHEN winner = player THEN 1 ELSE 0 END) AS wins,
                           SUM(CASE WHEN winner IS NOT NULL AND winner != player THEN 1 ELSE 0 END) AS losses,
                           SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END) AS draws,
                           COUNT(*) AS played
                    FROM played
                    GROUP BY player
                    HAVING played > 0
                    ORDER BY wins DESC, (wins * 1.0 / played) DESC
                    LIMIT :lim
                ");
                $stmt->bindValue(':gt', $gameType);
                $stmt->bindValue(':lim', $limit, PDO::PARAM_INT);
                $stmt->execute();
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($rows as &$r) {
                    $r['wins']   = (int)$r['wins'];
                    $r['losses'] = (int)$r['losses'];
                    $r['draws']  = (int)$r['draws'];
                    $r['played'] = (int)$r['played'];
                    $r['win_pct'] = $r['played'] > 0
                        ? round(100 * $r['wins'] / $r['played'], 1)
                        : 0;
                }
                unset($r);
                echo json_encode([
                    'success'     => true,
                    'game_type'   => $gameType,
                    'leaderboard' => $rows,
                ]);
            } catch (PDOException $e) {
                error_log('get-leaderboard failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to load leaderboard']);
            }
            break;

        case 'get-unread-dms':
            // Phase 3.8 — Mail / Message Archive. Returns DMs received since
            // the user last opened the mailbox, grouped by sender. The first
            // call after sign-up has no mail_last_seen_at; we treat that as
            // "24 hours ago" so a returning user sees recent context, not
            // every DM they've ever received.
            if (!isset($_SESSION['user'])) {
                http_response_code(401);
                echo json_encode(['error' => 'Authentication required']);
                break;
            }
            $me = $_SESSION['user']['username'];

            $stmt = $db->prepare("SELECT mail_last_seen_at FROM profiles WHERE username = :u");
            $stmt->execute(['u' => $me]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            $since = ($row && $row['mail_last_seen_at'])
                ? $row['mail_last_seen_at']
                : date('Y-m-d H:i:s', time() - 86400);

            try {
                // Total unread count + a recent sample (group by sender).
                $countStmt = $db->prepare("
                    SELECT COUNT(*) AS c FROM dm_messages
                    WHERE recipient = :me AND timestamp > :since
                ");
                $countStmt->execute(['me' => $me, 'since' => $since]);
                $total = (int)$countStmt->fetch(PDO::FETCH_ASSOC)['c'];

                $bySenderStmt = $db->prepare("
                    SELECT sender,
                           COUNT(*) AS unread_count,
                           MAX(timestamp) AS latest_timestamp,
                           (SELECT message FROM dm_messages d2
                            WHERE d2.recipient = :me AND d2.sender = dm_messages.sender
                              AND d2.timestamp > :since
                            ORDER BY d2.timestamp DESC LIMIT 1) AS latest_message
                    FROM dm_messages
                    WHERE recipient = :me AND timestamp > :since
                    GROUP BY sender
                    ORDER BY latest_timestamp DESC
                ");
                $bySenderStmt->execute(['me' => $me, 'since' => $since]);
                $bySender = $bySenderStmt->fetchAll(PDO::FETCH_ASSOC);
                foreach ($bySender as &$r) {
                    $r['unread_count']     = (int)$r['unread_count'];
                    $r['latest_timestamp'] = aim_iso_utc($r['latest_timestamp']);
                }
                unset($r);

                echo json_encode([
                    'success'      => true,
                    'total_unread' => $total,
                    'since'        => aim_iso_utc($since),
                    'by_sender'    => $bySender,
                ]);
            } catch (PDOException $e) {
                error_log('get-unread-dms failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to load mail']);
            }
            break;

        case 'mark-mail-seen':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                http_response_code(405);
                echo json_encode(['error' => 'Method not allowed']);
                break;
            }
            if (!isset($_SESSION['user'])) {
                http_response_code(401);
                echo json_encode(['error' => 'Authentication required']);
                break;
            }
            require_csrf();
            $me = $_SESSION['user']['username'];
            try {
                // UPSERT so users who haven't saved their profile yet still
                // get a row with mail_last_seen_at set.
                $stmt = $db->prepare("
                    INSERT INTO profiles (username, mail_last_seen_at, updated_at)
                    VALUES (:u, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT(username) DO UPDATE SET
                      mail_last_seen_at = CURRENT_TIMESTAMP
                ");
                $stmt->execute(['u' => $me]);
                echo json_encode(['success' => true]);
            } catch (PDOException $e) {
                error_log('mark-mail-seen failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['error' => 'Failed to mark mail seen']);
            }
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