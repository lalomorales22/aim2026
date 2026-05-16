# aim2026 — chat.laloadrianmorales.com

AIM '95-inspired chat. PHP frontend on Bluehost, Node WebSocket relay on Railway, source of truth on GitHub at <https://github.com/lalomorales22/aim2026>.

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

**Short version:** GitHub is where the code lives. Railway pulls from GitHub automatically and runs the Node WebSocket server. Bluehost is where the PHP/HTML/CSS/images live — Bluehost doesn't auto-pull from GitHub, so you upload those files yourself (or use cPanel's Git Version Control feature, see below).

**Why both Bluehost and Railway?** Bluehost is shared PHP hosting — perfect for the PHP backend and SQLite database, but it can't run a long-lived Node WebSocket process. Railway is great for Node WebSockets but you'd have to rewrite the PHP+SQLite half if you moved everything there. So we split: PHP stays on Bluehost, realtime moves to Railway, both load from the same browser session.

## Files at a glance

| File | Runs on | Notes |
| --- | --- | --- |
| `index.php`, `backend.php`, `script.js`, `style.css`, `images/`, `.htaccess` | **Bluehost** | Frontend, auth, REST endpoints, room/message persistence |
| `chatrooms.db` | **Bluehost** | SQLite — not in git (see `.gitignore`); lives in `public_html` |
| `server.js`, `package.json`, `package-lock.json`, `railway.json`, `Procfile` | **Railway** | Node WebSocket relay |
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

1. Open your Railway project → the **Production** service you already have.
2. *Settings → Source* → connect GitHub → pick `lalomorales22/aim2026` → branch `main`.
3. *Settings → Networking* → **Generate Domain**. Copy the result, e.g. `aim2026-production.up.railway.app`.
4. No env vars needed. Railway sets `PORT` automatically; `server.js` reads it.
5. Healthcheck is preconfigured in `railway.json` (path `/health`, 30s timeout).
6. Trigger a deploy. The build log should end with `aim-chat ws server listening on :8080`. Open `https://YOUR-RAILWAY-DOMAIN/health` in a browser — you should see JSON `{"status":"ok",...}`.

From now on, every push to `main` on GitHub auto-deploys to Railway.

### 3. Tell Bluehost where Railway lives

Edit the top of `index.php`:

```php
$WS_HOST = getenv('WS_HOST') ?: 'REPLACE_WITH_RAILWAY_DOMAIN.up.railway.app';
```

Replace the placeholder with the domain Railway gave you. No `https://`, no trailing slash.

### 4. Upload to Bluehost

Pick one of these — both work, second is less tedious long-term:

**Option A: cPanel File Manager / FTP (one-off)**

Upload everything **except** these Railway/dev-only files to `public_html`:
- `server.js`, `package.json`, `package-lock.json`, `node_modules/`, `railway.json`, `README.md`, `.gitignore`

The minimum Bluehost needs: `index.php`, `backend.php`, `script.js`, `style.css`, `.htaccess`, `images/`, and `chatrooms.db` (only if you want to keep your existing users/rooms — otherwise it'll be auto-created on first request).

**Option B: cPanel Git Version Control (recommended)**

cPanel can clone the GitHub repo straight into Bluehost and pull updates with one click:

1. cPanel → **Git Version Control** → *Create*.
2. Clone URL: `https://github.com/lalomorales22/aim2026.git`. Repository Path: `/home/USERNAME/public_html` (or a subfolder that you then symlink). Branch: `main`.
3. After the first clone, use the *Pull or Deploy* tab whenever you push new PHP changes.
4. The Node/Railway files will sit alongside the PHP — Bluehost will just ignore them since Apache only serves what `.htaccess` lets through.

If you want Bluehost to skip the Node files explicitly, append this to `.htaccess`:

```apache
<FilesMatch "^(server\.js|package(-lock)?\.json|railway\.json|README\.md|\.gitignore)$">
  Require all denied
</FilesMatch>
```

## Verifying end-to-end

1. Visit `https://chat.laloadrianmorales.com/`. Log in.
2. DevTools → Network → **WS** tab. You should see a connection to `wss://YOUR-RAILWAY-DOMAIN/` upgrade to status `101`.
3. DevTools → Console: `WebSocket connection established`.
4. Open the site in a second browser/incognito, log in as a different user, join the same room. Messages should fan out instantly between both tabs.
5. Railway logs should show `[ws] connect …` / `[ws] identify <nick>` per user.

## Day-to-day flow

- Change PHP/frontend: edit locally → `git push` → upload the changed files to Bluehost (or pull in cPanel).
- Change WebSocket logic: edit `server.js` → `git push` → Railway auto-redeploys.
- Database changes (`chatrooms.db`): they happen live on Bluehost. The file is gitignored so your local copy won't clobber production.

## Known limitations

- **DM history is in-memory** on Railway. It resets on every redeploy/restart. Room messages are unaffected — those persist through `backend.php` → SQLite on Bluehost.
- **No auth on the WS server.** Whoever connects can claim any nickname. Matches the previous Heroku setup. To lock it down later, mint a short-lived token in `backend.php` after login and verify it in `server.js` during `identify`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Console: `WebSocket connection to 'wss://…' failed` | `$WS_HOST` in `index.php` still says `REPLACE_WITH_…`, or Railway service is down. Hit `/health` directly. |
| `Mixed Content: insecure WebSocket` | Page is `https://` but JS fell through to the old Heroku string. Hard-reload to bust browser cache; double-check `window.WS_HOST` is set in view-source. |
| Repeated `Reconnecting (attempt N)...` | Railway returned non-101 on upgrade — usually a failed healthcheck causing rollback. Check Railway deploy logs. |
| Messages drop every few minutes | Heartbeat is 30s; lower `HEARTBEAT_INTERVAL_MS` in `server.js` to 15000 if a proxy is closing idles. |
| Bluehost serves `server.js` as plain text | Harmless but ugly. Add the `<FilesMatch>` block above to `.htaccess`, or just don't upload `server.js` to Bluehost. |
