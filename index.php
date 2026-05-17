<?php
// Load WS_SECRET (and any other env vars) before anything reads them.
// .user.ini + auto_prepend_file works on most Bluehost accounts but is brittle
// (5-minute INI cache, can be disabled by host policy), so include it
// explicitly here too — getenv() is cheap and idempotent.
if (is_readable(__DIR__ . '/.aim-env.php')) {
    require_once __DIR__ . '/.aim-env.php';
}

session_start();

// ---------------------------------------------------------------------------
// WebSocket host (Railway). Replace the value below with your Railway public
// domain — no protocol, no trailing slash. Example:
//   $WS_HOST = 'aim-chat-production.up.railway.app';
// You can also set it via the WS_HOST environment variable in cPanel.
// ---------------------------------------------------------------------------
$WS_HOST = getenv('WS_HOST') ?: 'web-production-8a622.up.railway.app';

// CSRF token — one per session, regenerated on auth state change in backend.php.
if (empty($_SESSION['csrf_token'])) {
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}
$csrfToken = $_SESSION['csrf_token'];

// Handle logout
if (isset($_GET['logout'])) {
    session_destroy();
    header('Location: index.php');
    exit;
}

// Mint a WS auth token for the logged-in user. Verified by server.js using the
// shared WS_SECRET env var (set on both Bluehost and Railway). Without WS_SECRET
// the system falls back to a non-HMAC marker so the rollout doesn't break.
function aim_mint_ws_token($nickname, $ttl = 86400) {
    $payload = json_encode(['nickname' => $nickname, 'exp' => time() + $ttl]);
    $b64 = rtrim(strtr(base64_encode($payload), '+/', '-_'), '=');
    $secret = getenv('WS_SECRET');
    $sig = $secret ? hash_hmac('sha256', $b64, $secret) : 'dev';
    return "$b64.$sig";
}

// Handle nickname selection
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['nickname'])) {
    // FILTER_SANITIZE_STRING is deprecated in PHP 8.1+, using alternative
    $nickname = htmlspecialchars(strip_tags(trim($_POST['nickname'])));
    if (!empty($nickname)) {
        $_SESSION['nickname'] = $nickname;
    }
}

// Check if user is logged in
$isLoggedIn = isset($_SESSION['user']);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#008080">
    <meta name="description" content="AIM Chat - A retro-style instant messenger">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="AIM Chat">
    <meta name="application-name" content="AIM Chat">
    <link rel="manifest" href="manifest.json">
    <title>AIM Chat</title>
    <link rel="stylesheet" href="style.css">
    <style>
        /* Form-state visibility (login vs register) is controlled via JS toggling .active. */
        .login-form,
        .register-form { display: none; }
        .login-form.active,
        .register-form.active { display: block; }
    </style>
</head>
<body>
    <?php if (!$isLoggedIn): ?>
    <!-- Sign-on splash — hidden until the user submits the sign-in form;
         JS triggers the signon1→2→3 dial-up sequence then reloads. -->
    <div class="splash-screen" id="splash-screen" style="display: none;">
        <div class="splash-frame">
            <img src="images/signon1.png" alt="Connecting" id="splash-image">
            <div class="splash-caption" id="splash-caption">Dialing&hellip;</div>
        </div>
    </div>
    <?php endif; ?>
    
    <div class="win95-container">
        <div class="taskbar">
            <div class="start-button">Start</div>
            <?php if ($isLoggedIn): ?>
            <div class="taskbar-user">
                <img src="images/user-icon-small.png" alt="User">
                <?php echo htmlspecialchars($_SESSION['user']['username']); ?>
            </div>
            
            <!-- Active chatrooms indicator in taskbar -->
            <div class="taskbar-chatrooms">
                <img src="images/chatrooms-icon-small.png" alt="Chatrooms">
                <span id="active-rooms-count">0</span>
            </div>
            <?php endif; ?>
            <div class="taskbar-time" id="taskbar-time"></div>
        </div>
        
        <?php if (!$isLoggedIn): ?>
            <div class="window login-window" id="login-window">
                <div class="window-header">
                    <div class="window-title">AIM Chat &mdash; Sign On</div>
                    <div class="window-controls">
                        <button class="control-button minimize">-</button>
                        <button class="control-button maximize">□</button>
                        <button class="control-button close">×</button>
                    </div>
                </div>
                <div class="window-content">
                    <div class="login-container">
                        <img src="images/aol-logo.png" alt="AOL Logo" class="aol-logo">
                        
                        <!-- Login Form -->
                        <div class="login-form active" id="login-form">
                            <h2>Welcome to AIM Chat</h2>
                            <div class="form-group">
                                <label for="username">Username:</label>
                                <input type="text" id="username" name="username" required>
                            </div>
                            <div class="form-group">
                                <label for="password">Password:</label>
                                <input type="password" id="password" name="password" required>
                            </div>
                            <div class="form-error" id="login-error"></div>
                            <div class="login-actions">
                                <button type="button" class="win95-button primary-button" id="login-button">Sign In</button>
                                <button type="button" class="win95-button secondary-button" id="show-register">Register</button>
                            </div>
                        </div>
                        
                        <!-- Register Form -->
                        <div class="register-form" id="register-form">
                            <h2>Create New Account</h2>
                            <div class="form-group">
                                <label for="new-username">Choose Username:</label>
                                <input type="text" id="new-username" name="new-username" required>
                            </div>
                            <div class="form-group">
                                <label for="new-password">Choose Password:</label>
                                <input type="password" id="new-password" name="new-password" required>
                            </div>
                            <div class="form-group">
                                <label for="confirm-password">Confirm Password:</label>
                                <input type="password" id="confirm-password" name="confirm-password" required>
                            </div>
                            <div class="form-error" id="register-error"></div>
                            <div class="login-actions">
                                <button type="button" class="win95-button primary-button" id="register-button">Create Account</button>
                                <button type="button" class="win95-button secondary-button" id="show-login">Back to Login</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        <?php else: ?>
            <div class="desktop">
                <div class="desktop-icon" id="chatrooms-icon">
                    <img src="images/chatrooms-icon.png" alt="Chatrooms">
                    <span>Chatrooms</span>
                </div>
                
                <div class="desktop-icon" id="user-profile-icon">
                    <img src="images/user-profile-icon.png" alt="My Profile">
                    <span>My Profile</span>
                </div>

                <div class="desktop-icon" id="active-users-icon">
                    <img src="images/active-users-icon.png" alt="Buddy List">
                    <span class="user-count">0</span>
                    <span>Buddy List</span>
                </div>

                <div class="desktop-icon" id="logout-icon">
                    <img src="images/logout-icon.png" alt="Logout">
                    <span>Logout</span>
                </div>
            </div>
            
            <!-- Chatrooms Window -->
            <div class="window" id="chatrooms-window" style="display: none;">
                <div class="window-header">
                    <div class="window-title">AIM Chat &mdash; Chatrooms</div>
                    <div class="window-controls">
                        <button class="control-button minimize">-</button>
                        <button class="control-button maximize">□</button>
                        <button class="control-button close">×</button>
                    </div>
                </div>
                <div class="window-content">
                    <div class="toolbar">
                        <button class="win95-button" id="create-room-btn">Create Room</button>
                        <button class="win95-button" id="refresh-rooms-btn">Refresh</button>
                    </div>
                    <div class="room-list" id="room-list">
                        <div class="loading">Loading chatrooms...</div>
                    </div>
                </div>
            </div>
            
            <!-- Create Room Dialog -->
            <div class="window dialog" id="create-room-dialog" style="display: none;">
                <div class="window-header">
                    <div class="window-title">Create New Chatroom</div>
                    <div class="window-controls">
                        <button class="control-button close">×</button>
                    </div>
                </div>
                <div class="window-content">
                    <form id="create-room-form">
                        <div class="form-group">
                            <label for="room-name">Room Name:</label>
                            <input type="text" id="room-name" name="room-name" required>
                        </div>
                        <div class="dialog-buttons">
                            <button type="submit" class="win95-button">Create</button>
                            <button type="button" class="win95-button" id="cancel-create-room">Cancel</button>
                        </div>
                    </form>
                </div>
            </div>

            <!-- Buddy List Window (static — see also the JS-created #active-now-window) -->
            <div class="window" id="active-users-window" style="display: none;">
                <div class="window-header">
                    <div class="window-title">Buddy List</div>
                    <div class="window-controls">
                        <button class="control-button minimize">-</button>
                        <button class="control-button maximize">□</button>
                        <button class="control-button close">×</button>
                    </div>
                </div>
                <div class="window-content">
                    <div class="toolbar">
                        <button class="win95-button" id="refresh-users-btn">Refresh</button>
                    </div>
                    <div class="active-users-list" id="active-users-list">
                        <div class="loading">Loading buddy list...</div>
                    </div>
                </div>
            </div>
            
            <!-- Chat Window Template (will be cloned by JavaScript) -->
            <div class="window chat-window" id="chat-window-template" style="display: none;">
                <div class="window-header">
                    <div class="window-title">Chat: </div>
                    <div class="window-controls">
                        <button class="control-button minimize">-</button>
                        <button class="control-button maximize">□</button>
                        <button class="control-button close">×</button>
                    </div>
                </div>
                <div class="window-content">
                    <div class="chat-messages"></div>
                    <div class="chat-status">
                        <span class="online-users">Users online: 0</span>
                        <span class="typing-indicator"></span>
                    </div>
                    <div class="chat-input">
                        <input type="text" placeholder="Type your message..." class="message-input">
                        <button class="win95-button send-button">Send</button>
                    </div>
                </div>
            </div>
        <?php endif; ?>
    </div>
    
    <!-- System sounds (AOL / AIM '95-era .wav files in /sounds) -->
    <audio id="connecting-sound" preload="auto"><source src="sounds/connecting.wav" type="audio/wav"></audio>
    <audio id="startup-sound"    preload="auto"><source src="sounds/startup.wav"    type="audio/wav"></audio>
    <audio id="error-sound"      preload="auto"><source src="sounds/error.wav"      type="audio/wav"></audio>
    <audio id="chat-sound"       preload="auto"><source src="sounds/chat.wav"       type="audio/wav"></audio>
    <audio id="gotmail-sound"    preload="auto"><source src="sounds/gotmail.wav"    type="audio/wav"></audio>
    <audio id="goodbye-sound"    preload="auto"><source src="sounds/goodbye.wav"    type="audio/wav"></audio>
    <audio id="drop-sound"       preload="auto"><source src="sounds/drop.wav"       type="audio/wav"></audio>
    <audio id="buddyin-sound"    preload="auto"><source src="sounds/buddyin.wav"    type="audio/wav"></audio>
    <audio id="buddyout-sound"   preload="auto"><source src="sounds/buddyout.wav"   type="audio/wav"></audio>
    <audio id="filedone-sound"   preload="auto"><source src="sounds/filedone.wav"   type="audio/wav"></audio>
    
    <script>
        // WebSocket host for the Railway-hosted realtime server.
        window.WS_HOST = "<?php echo htmlspecialchars($WS_HOST, ENT_QUOTES); ?>";
        // CSRF token used by apiPost() for all backend POSTs.
        window.CSRF_TOKEN = "<?php echo htmlspecialchars($csrfToken, ENT_QUOTES); ?>";
    </script>
    <?php if ($isLoggedIn): ?>
    <script>
        // Store user info for WebSocket connection
        const userInfo = {
            nickname: "<?php echo htmlspecialchars($_SESSION['user']['username']); ?>",
            id: <?php echo (int)$_SESSION['user']['id']; ?>,
            isAdmin: <?php echo $_SESSION['user']['username'] === 'lalopenguin' ? 'true' : 'false'; ?>
        };
        // Signed token the Node WS server verifies on `identify`.
        window.WS_TOKEN = "<?php echo htmlspecialchars(aim_mint_ws_token($_SESSION['user']['username']), ENT_QUOTES); ?>";
    </script>
    <?php endif; ?>
    
    <script src="script.js"></script>
</body>
</html>