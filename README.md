# aim2026 — chat.laloadrianmorales.com

AIM '95-inspired chat. PHP frontend on Bluehost, Node WebSocket relay on Railway, source of truth on GitHub at <https://github.com/lalomorales22/aim2026>.

**Live realtime endpoint:** `wss://web-production-8a622.up.railway.app` (healthcheck at `/health`).

## How the three hosts fit together

```
                ┌────────────────────────────────┐
                │     GitHub (aim2026 repo)      │   ← you push code here
                │   source of truth for code     │
                └───────────────┬────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
              ▼ auto-deploy on push               ▼ manual upload (or cPanel Git)
   ┌──────────────────────┐            ┌──────────────────────────────┐
   │  Railway (Production)│            │ Bluehost public_html         │
   │  runs server.js      │            │ serves index.php, backend.php│
   │  realtime WebSocket  │◄──── wss ──┤ script.js, style.css, images │
   └──────────────────────┘            │ chatrooms.db (SQLite)        │
                                       └──────────────────────────────┘
                                                    ▲
                                                    │ https
                                                    │
                                              your browser
```

**Short version:** GitHub is where the code lives. Railway auto-pulls from GitHub and runs the Node WebSocket server. Bluehost is where the PHP/HTML/CSS/images live — Bluehost doesn't auto-pull from GitHub, so you upload those files yourself (or use cPanel's Git Version Control feature, see below).

**Why both Bluehost and Railway?** Bluehost is shared PHP hosting — perfect for the PHP backend and SQLite database, but it can't run a long-lived Node WebSocket process. Railway is great for Node WebSockets but you'd have to rewrite the PHP+SQLite half if you moved everything there. So we split: PHP stays on Bluehost, realtime moves to Railway, both load from the same browser session.

## Files at a glance

| File | Runs on | Notes |
| --- | --- | --- |
| `index.php`, `backend.php`, `script.js`, `style.css`, `images/`, `.htaccess` | **Bluehost** | Frontend, auth, REST endpoints, room/message persistence |
| `chatrooms.db` | **Bluehost** | SQLite — gitignored; lives in `public_html`. **Never overwrite it from your local copy** — production has live user data. |
| `server.js`, `package.json`, `package-lock.json`, `Procfile`, `nixpacks.toml`, `railway.json` | **Railway** | Node WebSocket relay + build config |
| `README.md`, `.gitignore` | **GitHub only** | Repo metadata |

## First-time setup

### 1. Push this folder to GitHub

```bash
cd /Users/megabrain/Downloads/chat.laloadrianmorales.com
git init
git add .
git commit -m "Initial commit: PHP frontend + Railway WS server"
git branch -M main
git remote add origin https://github.com/lalomorales22/aim2026.git
git push -u origin main
```

### 2. Connect Railway to the repo

1. Open your Railway project → create a service from **GitHub Repository**.
2. Authorize the Railway GitHub app for `lalomorales22/aim2026` (or "All repositories").
3. Pick `lalomorales22/aim2026`, branch `main`.
4. *Settings → Networking* → **Generate Domain**. Copy the result (e.g. `web-production-8a622.up.railway.app`).
5. No env vars needed. Railway sets `PORT` automatically; `server.js` reads it.
6. Healthcheck is preconfigured in `railway.json` (path `/health`, 30s timeout).
7. Wait for the build. Log should end with `aim-chat ws server listening on :8080`. Open `https://YOUR-RAILWAY-DOMAIN/health` — expect `{"status":"ok",...}`.

From now on, every push to `main` auto-deploys.

> **Why `nixpacks.toml` exists.** Nixpacks (Railway's build system) auto-detects the repo's languages. Because this folder contains `index.php` + `backend.php` *and* `server.js`, Nixpacks tries to build a hybrid PHP+nginx+Node image, which fails with `error: undefined variable 'nodejs_24'` in the Nix derivation. The `nixpacks.toml` here forces `providers = ["node"]` and pins Node 22 so the build is Node-only. The `engines: 22.x` in `package.json` reinforces this. Don't remove them.

### 3. Tell Bluehost where Railway lives

`index.php` already has the live Railway domain baked in:

```php
$WS_HOST = getenv('WS_HOST') ?: 'web-production-8a622.up.railway.app';
```

If Railway hands you a new domain (e.g. after deleting/recreating the service), update that line, commit, push, then re-upload `index.php` to Bluehost. Alternatively, set `WS_HOST=...` as a cPanel env var and the PHP will pick it up without editing the file.

### 4. Upload to Bluehost

Pick one of these — both work, second is less tedious long-term:

**Option A: cPanel File Manager / FTP (one-off)**

When you change the frontend, the only two files that need to be re-uploaded to `public_html/` are:
- `index.php`
- `script.js`

…and only when those specific files change. `backend.php`, `style.css`, `images/`, `.htaccess` rarely change and don't need to be re-uploaded each time.

**Do NOT overwrite `chatrooms.db`** on Bluehost from your local copy — production has live users and messages. The local copy is stale the moment anyone logs in on the live site.

Files that should never be uploaded to Bluehost (Railway-only or repo metadata):
`server.js`, `package.json`, `package-lock.json`, `node_modules/`, `nixpacks.toml`, `railway.json`, `Procfile`, `README.md`, `.gitignore`

**Option B: cPanel Git Version Control (recommended)**

cPanel can clone the GitHub repo straight into Bluehost and pull updates with one click:

1. cPanel → **Git Version Control** → *Create*.
2. Clone URL: `https://github.com/lalomorales22/aim2026.git`. Repository Path: `/home/USERNAME/public_html` (or a subfolder you symlink). Branch: `main`.
3. After the first clone, use the *Pull or Deploy* tab whenever you push PHP/JS changes.
4. The Node/Railway files will sit alongside the PHP — Apache only serves what `.htaccess` lets through, but if you want belt-and-suspenders, add this to `.htaccess` to deny them explicitly:

```apache
<FilesMatch "^(server\.js|package(-lock)?\.json|railway\.json|nixpacks\.toml|Procfile|README\.md|\.gitignore)$">
  Require all denied
</FilesMatch>
```

## Verifying end-to-end

1. Visit `https://chat.laloadrianmorales.com/`. Log in.
2. DevTools → Network → **WS** tab. Look for a connection to `wss://web-production-8a622.up.railway.app/` with status `101 Switching Protocols`.
3. DevTools → Console: `WebSocket connection established`.
4. Open the site in a second browser/incognito, log in as a different user, join the same room. Messages should appear instantly on both sides.
5. Railway → service → **Logs**: `[ws] connect …` / `[ws] identify <nick>` per user.

## Day-to-day flow

- Frontend change (PHP/JS/CSS): edit → `git push` → upload changed files to Bluehost (or pull in cPanel).
- WebSocket-server change: edit `server.js` → `git push` → Railway auto-redeploys (~60–90s).
- DB changes: happen live on Bluehost via `backend.php`. The local `chatrooms.db` is gitignored and stale by design.
- Anything that changes the WS protocol needs **matching** edits to `server.js` *and* `script.js`. The protocol is in sync today; keep it that way.

## Known limitations

- **DM history is in-memory** on Railway. It resets on every redeploy/restart. Room messages are unaffected — those persist through `backend.php` → SQLite on Bluehost.
- **No auth on the WS server.** Whoever connects can claim any nickname. Matches the previous Heroku setup. To lock it down later, mint a short-lived token in `backend.php` after login and verify it in `server.js` during `identify`.
- **Passwords are stored as bare SHA-256** (no salt, no bcrypt) — see `backend.php`. Fine for a toy, would be a real concern if this ever held meaningful accounts.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Console: `WebSocket connection to 'wss://…' failed` | `$WS_HOST` in `index.php` still says `REPLACE_WITH_…`, or Railway service is down. Hit `/health` directly. |
| `Mixed Content: insecure WebSocket` | Page is `https://` but JS fell through to the old Heroku string (you re-uploaded `index.php` without re-uploading the updated `script.js`). Hard-reload to bust browser cache. |
| Repeated `Reconnecting (attempt N)...` | Railway returned non-101 on upgrade — usually a failed healthcheck causing rollback. Check Railway deploy logs. |
| Messages drop every few minutes | Heartbeat is 30s; lower `HEARTBEAT_INTERVAL_MS` in `server.js` to 15000 if a proxy is closing idles. |
| Bluehost serves `server.js` as plain text | Add the `<FilesMatch>` block above to `.htaccess`, or just don't upload `server.js` to Bluehost. |
| Railway build fails with `error: undefined variable 'nodejs_24'` | `nixpacks.toml` is missing or got reverted. It must contain `providers = ["node"]` and `nixPkgs = ["nodejs_22"]`. Combined with `"engines": { "node": "22.x" }` in `package.json`. |
| Railway healthcheck times out | Service might be cold-starting or wrong port. Confirm `server.js` listens on `process.env.PORT` (it does) and that `/health` is the configured path in `railway.json`. |
| `Application not found` on the Railway domain | Domain reserved but no successful deploy yet, or domain attached to a different service. Check Deployments tab + Networking settings. |
