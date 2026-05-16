<?php
// Template for .aim-env.php — copy this to .aim-env.php on Bluehost and
// fill in your WS_SECRET (must match the same env var set in Railway).
// The real .aim-env.php is gitignored so the secret never lands in git.
//
// Loaded automatically before every PHP request via .user.ini's
// auto_prepend_file directive.
putenv('WS_SECRET=replace_with_openssl_rand_hex_32_value');
