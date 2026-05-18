<?php
// Template for .aim-env.php — copy this to .aim-env.php on Bluehost and
// fill in your WS_SECRET (must match the same env var set in Railway).
// The real .aim-env.php is gitignored so the secret never lands in git.
//
// Loaded by index.php and backend.php via `require_once __DIR__ . '/.aim-env.php'`.
// .user.ini's auto_prepend_file directive also loads it on hosts that honor
// it, but the require is the authoritative path.
putenv('WS_SECRET=replace_with_openssl_rand_hex_32_value');

// Bootstrap password for the 'lalopenguin' admin account — only used to
// create the row the first time. Existing accounts are not updated.
putenv('ADMIN_PASSWORD=replace_with_a_strong_password');

// Internal token Railway uses when calling back into backend.php (e.g.
// the save-dm endpoint that persists DM history to SQLite). Must match
// the BACKEND_API_TOKEN env var set on Railway. Generate with:
//   openssl rand -hex 32
// If unset, backend.php refuses internal requests — DMs won't persist.
putenv('BACKEND_API_TOKEN=replace_with_openssl_rand_hex_32_value');

// Optional: flip to '1' to turn on verbose error logging + display_errors.
// Leave unset (or set to '0') in production.
// putenv('AIM_DEBUG=1');
