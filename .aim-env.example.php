<?php
// Template for .aim-env.php — copy this to .aim-env.php on Bluehost and
// fill in your WS_SECRET (must match the same env var set in Railway).
// The real .aim-env.php is gitignored so the secret never lands in git.
//
// Loaded by index.php and backend.php via `require_once __DIR__ . '/.aim-env.php'`.
// .user.ini's auto_prepend_file directive also loads it on hosts that honor
// it, but the require is the authoritative path.
putenv('WS_SECRET=replace_with_openssl_rand_hex_32_value');
