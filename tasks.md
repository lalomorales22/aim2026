# aim2026 Upgrade Plan — Games, Items & 90s Fun

> *"You've Got Mail!"* — but now you've also got Tic Tac Toe, Rock Paper Scissors,
> away messages, buddy icons, smileys, and a whole arcade of 1990s mischief.

This document walks through a four-phase upgrade for **chat.laloadrianmorales.com**
(aim2026). Each phase is self-contained, deployable on its own, and builds on
the last. Filenames map to the three-host split: **Bluehost** (PHP/JS/CSS/DB),
**Railway** (`server.js`), **GitHub** (source of truth).

---

## Part 0 — Where we are today (review)

### Architecture recap

| Tier | Host | What it does |
| --- | --- | --- |
| Frontend | Bluehost `public_html/` | `index.php`, `script.js` (~2,500 LOC), `style.css` (~3,150 LOC), images, sounds |
| Persistence | Bluehost SQLite | `chatrooms.db` — `users`, `rooms`, `messages`, `buddies` |
| Realtime | Railway | `server.js` Node + `ws` — relays messages, DMs, roster, typing |
| Source | GitHub `lalomorales22/aim2026` | Auto-deploys to Railway on push; manual upload to Bluehost |

### Features that already work

- Login / Register (bcrypt, with legacy SHA-256 auto-upgrade on login)
- CSRF-protected POST endpoints (`apiPost` helper in `script.js`)
- HMAC-signed WS auth tokens (`WS_SECRET` shared between Bluehost + Railway)
- Chatrooms with persistent history (paginated 50-at-a-time)
- Direct Messages (in-memory on Railway, 200/pair cap, lost on redeploy)
- Buddy List (SQLite-backed, optimistic add/remove, localStorage cold-start cache)
- Active Users window with auto-refresh and buddy-online chimes
- Profile (display name, bio, avatar color, status, sound toggle, typing indicator)
- Windows 95 chrome: draggable windows, taskbar, Start menu, system clock, splash dial-up sequence
- Admin (`lalopenguin`) can delete chatrooms; room-name slur filter
- 10 sound effects: connecting, startup, error, chat, gotmail, goodbye, drop, buddyin, buddyout, filedone

### Gaps & opportunities

**No games of any kind.** No challenge/invite protocol, no per-DM game state, no
turn arbitration on the server. The chat is the chat — that's it.

**Polish gaps that hurt the vibe:**
- DM history vanishes on every Railway redeploy
- No away messages (the most iconic AIM feature after the door slam)
- No buddy icons — avatars are a single solid color
- No smileys / emoticons picker (no `:)` → 😀 substitution)
- No text formatting in chat (no bold, italic, color, font)
- No way to view someone else's profile by clicking their name
- No mail / message archive
- No buddy-signs-on alert ("Door" sound + popup)
- Profile is browser-local (`localStorage`) — doesn't follow you across devices

**Code hygiene to clean up along the way:**
- `script.js:2167` — dead Heroku fallback `aim-chat-56ce9127edbc.herokuapp.com` (we're on Railway now)
- `backend.php:11-14` — `display_errors=1` enabled in production (turn off after debugging stabilizes)
- `backend.php` — many `error_log()` calls that bloat the 91 KB `error_log` file
- No rate limiting on any endpoint (a single bad actor can flood `save-message`)
- No tests anywhere — at minimum, server-arbitrated games need unit tests

---

## Phase 1 — Foundation (the plumbing every game needs)

**Goal:** ship the invisible scaffolding so Phase 2's games are a small lift.
**Estimated effort:** 1–2 evenings. **Ships:** no user-visible games yet, but a
"Challenge a buddy…" stub that says *"Coming soon."*

### 1.1 Generic challenge / invite protocol (`server.js` + `script.js`)

Add a single **game-agnostic** invite envelope so every Phase 2/4 game reuses it.

**New WebSocket message types** (additions to the table in `server.js` header comment):

```
in:  game_invite     { to, gameType, gameId }
     game_accept     { from, gameId }
     game_decline    { from, gameId }
     game_move       { gameId, move }     // payload shape is per-game
     game_resign     { gameId }
     game_chat       { gameId, message }  // in-game taunt window
out: game_invite, game_accept, game_decline, game_state, game_over,
     game_chat, game_error
```

Server keeps an in-memory `games` map keyed by `gameId` (UUIDv4 minted PHP-side
when inviting, or by `crypto.randomUUID()` server-side as a fallback). The map
stores `{ gameType, players:[a,b], state, createdAt, lastMoveAt }`. Garbage-collect
games idle > 30 min.

### 1.2 Game window template (`index.php` + `script.js` + `style.css`)

Reusable Win95 chrome for any board game. Looks like the chat window template
but with three regions:
- **Top:** opponent's screen name + avatar + W/L record
- **Middle:** game-specific board (slot for Phase 2 to fill)
- **Bottom:** in-game chat strip + "Resign" / "Rematch" buttons

Add `#game-window-template` next to `#chat-window-template` in `index.php`.
Style block goes in a new `/* ---- Games ---- */` section near the bottom of
`style.css` so it's easy to find.

### 1.3 Persistent DM + game-message history (`backend.php` + `server.js`)

DMs disappearing on Railway redeploy is a long-standing wart; games make it
worse (no challenge receipt). Add a `dm_messages` table on Bluehost:

```sql
CREATE TABLE dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'game_invite' | 'game_result'
  payload TEXT,                               -- JSON for non-text types
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_dm_pair_time ON dm_messages(sender, recipient, timestamp);
```

New endpoints in `backend.php`: `save-dm`, `get-dm-history` (paginated like
`get-messages`). `server.js` writes DMs through to Bluehost via a single
non-blocking `fetch()` per send (Railway → Bluehost over HTTPS). Failure is
logged but doesn't block the realtime fanout.

### 1.4 Server-backed profiles (`backend.php` + `script.js`)

Move profile from `localStorage` into a new `profiles` table:

```sql
CREATE TABLE profiles (
  username TEXT PRIMARY KEY,
  display_name TEXT,
  bio TEXT,
  avatar_color TEXT,
  avatar_icon TEXT,        -- reserved for Phase 3 buddy icons
  away_message TEXT,       -- reserved for Phase 3
  sound_pack TEXT,         -- reserved for Phase 3
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Endpoints: `get-profile?username=...`, `save-profile` (POST, CSRF-required).
`script.js` keeps the localStorage cache as a fast-read fallback but treats the
server as authoritative.

### 1.5 New sound effects (`/sounds`, `index.php`)

Drop in these AIM/AOL-era WAVs (sourced from the same packs you used for the
existing sounds, public-domain or `archive.org`):
- `challenge.wav` — door knock, plays on incoming game invite
- `gamewin.wav` — short fanfare
- `gameloss.wav` — sad trombone
- `gamemove.wav` — soft "click" for opponent move
- `gametie.wav` — neutral chime

Add corresponding `<audio>` tags to the bottom of `index.php`.

### 1.6 Cleanup checklist

- [ ] `script.js:2167` — delete the dead `'aim-chat-56ce9127edbc.herokuapp.com'` fallback
- [ ] `backend.php:11-14` — wrap `display_errors` in `if (getenv('AIM_DEBUG'))`
- [ ] `backend.php` — gate `error_log()` calls behind the same env var
- [ ] Add minimal Node test harness (`npm test` → a few `node:test` files for game logic)

### Phase 1 acceptance

- New game-invite ping sound plays when someone hits "Challenge a buddy" → *Coming Soon* dialog.
- DM history survives a Railway redeploy.
- Profile changes made on Browser A appear on Browser B after re-login.
- All four `<audio>` tags load without 404s.

---

## Phase 2 — Core Games (Tic Tac Toe + Rock Paper Scissors)

**Goal:** the two games called out in the brief, end-to-end, multiplayer, with
a "Challenge" button wired into the Buddy List and DM windows.
**Estimated effort:** 2–3 evenings. **Ships:** real multiplayer games.

### 2.1 Tic Tac Toe

**Server-side state** (`server.js`):

```js
{ board: Array(9).fill(null), turn: 'X', xPlayer, oPlayer, winner: null }
```

- Server validates every `game_move` (right player's turn, cell empty, game not over).
- Server computes `winner` after each move and broadcasts `game_state` to both players.
- On win/draw, server emits `game_over { result: 'win'|'loss'|'draw', winner }` and persists to a new `game_results` table.

**Client-side** (`script.js`):

- Add `renderTicTacToeBoard(gameId, state)` that paints a 3×3 grid of Win95 chunky buttons.
- Use beveled gray cells with hand-drawn X/O glyphs (CSS only — no images needed; or pixel-art PNGs if you want them sharper).
- Animate winning line with a 2px black diagonal stroke (CSS pseudo-element).

**DB schema**:

```sql
CREATE TABLE game_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_type TEXT NOT NULL,           -- 'ttt' | 'rps' | ...
  player_a TEXT NOT NULL,
  player_b TEXT NOT NULL,
  winner TEXT,                       -- nickname or NULL for draw
  played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  duration_seconds INTEGER
);
CREATE INDEX idx_results_players ON game_results(player_a, player_b);
CREATE INDEX idx_results_type_winner ON game_results(game_type, winner);
```

### 2.2 Rock Paper Scissors

Different mechanic: simultaneous reveal, best-of-3.

**Server-side state**:

```js
{
  round: 1, maxRounds: 3,
  scores: { [a]: 0, [b]: 0 },
  picks: { [a]: null, [b]: null },   // cleared each round
  history: []                        // [{ round, picks, winner }]
}
```

- Server waits for both `game_move { move: 'rock'|'paper'|'scissors' }` before resolving the round.
- Until both arrive, opponent sees a `game_state { youPicked: true, opponentPicked: false }` heads-up so the UI can show 🕒 "Waiting for opponent…".
- 30-second per-round timeout → auto-loss for the slow player (configurable).

**Client-side**:

- Three big Win95 buttons (Rock 🪨 / Paper 📄 / Scissors ✂️ — or pixel-art .png).
- After both pick, animate a quick "ROCK… PAPER… SCISSORS… SHOOT!" overlay (3 frames, 400 ms each) before revealing.
- Score chips top-left ("You 1 — Them 0").

### 2.3 Challenge entry points

Add a **"Challenge"** dropdown on each row of the Buddy List and inside every
DM window header:

```
[ Challenge ▾ ]
  ○ Tic Tac Toe
  ○ Rock Paper Scissors
```

Wire it through `socket.send({ type: 'game_invite', to, gameType, gameId })`.
Recipient sees a Win95 modal: *"<nick> wants to play Tic Tac Toe with you.
[Accept] [Decline]"*, with `challenge.wav` playing.

### 2.4 W/L record on profile

Aggregate from `game_results` per username and surface in the Profile window:

```
Tic Tac Toe:   12W — 4L — 2D
Rock Paper:    9W — 9L — 0D
```

Add a `get-stats?username=...` endpoint to `backend.php` that runs:

```sql
SELECT game_type,
       SUM(winner = :u) AS wins,
       SUM(winner IS NOT NULL AND winner != :u) AS losses,
       SUM(winner IS NULL) AS draws
FROM game_results
WHERE player_a = :u OR player_b = :u
GROUP BY game_type;
```

### 2.5 Tests (`server.js`)

Real unit tests for game logic — these *must* live server-side because the
server is the authority. Cover:
- TTT win detection on all 8 lines (rows, cols, diagonals)
- TTT draw detection (full board, no winner)
- TTT rejects moves out of turn / on occupied cells / after game-over
- RPS resolves all 9 pair combinations (R/R tie, R/P paper-wins, R/S rock-wins, …)
- RPS best-of-3 termination at score 2

### Phase 2 acceptance

- Two browsers, two accounts, can play a full TTT game start to finish.
- Same for RPS, best-of-3.
- W/L counts update after each game.
- A reload mid-game restores the board (server state is the source of truth).
- All game-logic tests pass: `npm test`.

---

## Phase 3 — 90s Polish & UX Layer (the AIM-feels stuff)

**Goal:** make the app feel like AIM in 2002, not a chat with two games bolted
on. Each item is small but the cumulative effect is huge.
**Estimated effort:** 3–4 evenings. **Ships:** the soul of the app.

### 3.1 Away Messages (the iconic one)

When a user sets themselves Away, any incoming DM gets an auto-reply with their
away text (just like 2002 AIM). Implementation:

- Add `away_message` field to `profiles` (Phase 1 schema reserved it).
- Status enum becomes `online | away | offline | invisible`.
- `server.js` checks the recipient's status on `direct_message` — if `away`, also push a `direct_message_sent { autoReply: true, text: awayMessage }` back to the sender.
- Profile window gains a status dropdown + multi-line away message textarea.
- Classic touch: pre-populate with rotating defaults like `"Brb, getting pizza rolls 🍕"` / `"AFK — see ya at 8!"`.

### 3.2 Buddy Icons (small avatar images)

Replace solid-color avatar with optional uploaded image.

- Add `avatar_icon` (data URL or path) to `profiles`.
- New endpoint `upload-buddy-icon` (POST, CSRF): accepts a base64-encoded image, validates size (≤ 64×64) and type (PNG/GIF/JPEG only), stores it in `public_html/buddy-icons/<username>.png` or in the DB as a data URL.
- Render the icon in Buddy List rows, DM windows, chat messages, and the Profile window.
- Provide a default-icon picker (10-15 pixel-art presets in `/images/avatars/`) for users who don't want to upload.

### 3.3 Emoticon / Smiley picker

Classic yellow AIM smileys 😀😉😢😡😎❤️.

- Add `/images/smileys/` (15-20 PNGs, 19×19 pixels — match the AOL Communicator era).
- New "😀" button in every chat input (room + DM + game-chat) that opens a small popup grid.
- Auto-substitute on send: `:)` → `<img src="images/smileys/smile.png">`, `:P` → tongue, `<3` → heart, etc.
- Make sure `escapeHtml()` in `script.js` runs *before* substitution, then whitelist the smiley `<img>` tags.

### 3.4 Text formatting toolbar

Tiny Win95 toolbar above each chat input: **B** *I* U, font color, font face.

- Send as a small JSON payload: `{ text, style: { bold, italic, color, font } }`.
- Server stores in `messages.message` as JSON if `style` present, plain string otherwise (backward-compatible — peek the first character).
- Render with a restricted `<span style="">` whitelist on the client.
- Maximum 1 color + 1 font per message (mid-90s AIM let you go nuts, but it looked bad — keep it tasteful).

### 3.5 Click-name-to-view-profile

Currently you can only see your own profile. Make every nickname clickable.

- New `showOtherProfileWindow(nickname)` in `script.js` — same layout as own Profile but read-only with a "Send IM", "Challenge", "Add Buddy", "Warn" footer.
- Fetch via `get-profile?username=...` + `get-stats?username=...`.

### 3.6 Buddy alerts (signs-on popup)

When a buddy on your list comes online, show a small Win95 popup near the
taskbar: *"BuddyName has signed on."* + door-open chime.

- Already half-done: `active_users` diffing on the client fires `buddyin-sound`. Extend it to:
  - Pop a 280×80 toast window (auto-dismiss after 4s).
  - Only fire for users on the *buddy list* (not every random online user).

### 3.7 Sound packs

Three swappable themes selectable in the Profile:
- **Classic AIM** (current sounds)
- **AOL 3.0** (gotmail, dial-up modem, door slam)
- **Mute except chat** (only `chat.wav` fires)

Implementation: `sound_pack` field in `profiles` (Phase 1 schema reserved it).
Each pack maps logical names (`chat`, `buddyin`, `error`) to file paths under
`/sounds/<pack>/`.

### 3.8 Mail / Message archive

The classic "You've Got Mail!" icon in the taskbar that opens a window listing
recent missed DMs.

- Aggregate from `dm_messages` (Phase 1) where `recipient = me` and `timestamp > last_seen_at`.
- Show count badge on the mailbox icon in the taskbar.

### Phase 3 acceptance

- Setting Away sends an auto-reply to incoming DMs.
- Uploading a buddy icon shows it everywhere your name appears.
- Smileys render in chat rooms, DMs, and game-chat.
- Bold/italic/color in a sent message renders correctly for the recipient.
- Clicking another user's name anywhere opens their profile.
- A buddy signing on triggers both the chime and a taskbar-area toast.

---

## Phase 4 — More Games & Bonus Fun (the arcade)

**Goal:** make the games section feel like an arcade, not a feature. Plus a few
nostalgic Easter eggs.
**Estimated effort:** open-ended; build games in any order.
**Ships:** Whatever subset you ship is value.

### 4.1 More multiplayer games (all use the Phase 1 invite protocol)

| Game | Mechanic | Notes |
| --- | --- | --- |
| **Connect Four** | Turn-based, 7×6 grid | Same engine pattern as TTT |
| **Checkers** | Turn-based, 8×8 grid, mandatory jumps | More logic; consider 1-week build |
| **Battleship** | 2-phase: place ships → take turns guessing | Server hides ship positions; only reveals hits |
| **Hangman** | One player picks word, other guesses | Word filter (reuse `is_bad_room_name()` logic) |
| **Trivia Showdown** | Both answer same question; faster correct wins | Question bank in `trivia_questions` SQLite table; bootstrap with ~500 questions |
| **Word Race** | Both race to type a given word/sentence first | Calibrate against WPM |

### 4.2 Single-player toys

| Toy | Where it lives |
| --- | --- |
| **Magic 8-Ball** | Start menu → Toys → 8-Ball; click ball → random AIM-era phrase |
| **Slot Machine** | Three 🍒/🍋/⭐/💎 reels; pure fun, no payout |
| **Solitaire** *(stretch)* | Win95 green-felt klondike; reuse existing card-image asset pack |

### 4.3 Spectator mode

In-progress games are listed in a new Start-menu **"Spectate Games"** window;
clicking joins as a read-only viewer. Server adds spectators to the game's
broadcast set but rejects their `game_move` packets.

### 4.4 Global leaderboard

New desktop icon **"Top Players"** → window with tabs per game showing top 10
W/L ratios. Pulls from `game_results`.

### 4.5 Stickers / animated GIFs

Curated pack of ~30 AIM-era animated GIFs (dancing baby, hampster dance, "All
Your Base", under construction). Toggle next to the smiley picker. Stored under
`/images/stickers/`.

### 4.6 Desktop wallpaper picker

Right-click the desktop → wallpaper picker. Options: teal default, Bliss
(Win XP green hill), Plus! `Forest`, `Clouds`, `Mystify`. Saves to `profiles`.

### 4.7 Screen savers (idle-only)

After 5 minutes of idle: 3D Maze, Pipes, or Mystify in a fullscreen overlay.
Click/key dismisses.

### 4.8 Easter eggs

- **Konami code** on the desktop → starts "Snake" in a window
- Type `/me <action>` in any chat → renders as italic third-person action
- Type `/roll 2d6` → server rolls dice and broadcasts the result
- Hidden room "The 90s" only joinable by typing its name exactly in Create Room

### 4.9 Mobile polish pass

Games on phones currently inherit the desktop window chrome. For ≤768 px:
- Single-game-fullscreen mode (no title bar, no taskbar — just the board)
- Larger tap targets (44 px minimum) on all game cells
- Pinch-zoom disabled inside game windows (CSS `touch-action: manipulation`)

### Phase 4 acceptance

- At least 2 additional multiplayer games shipped
- Magic 8-Ball lives in the Start menu
- Spectate window lists in-progress games
- Konami code starts Snake
- Phone playthrough of TTT and RPS feels good (no accidental scroll, no zoom)

---

## Deployment cheatsheet (per phase)

| File changed | Goes to |
| --- | --- |
| `server.js`, `package.json`, `package-lock.json` | `git push` → Railway auto-deploys |
| `index.php`, `script.js`, `style.css`, `images/*`, `sounds/*` | Upload to Bluehost `public_html/` (or pull via cPanel Git) |
| `backend.php` schema additions | Upload + first PHP request creates new tables via `CREATE TABLE IF NOT EXISTS` |
| Game-logic tests | Run locally with `npm test`; do not deploy test files to Bluehost |

**Never overwrite `chatrooms.db` on Bluehost.** Schema changes are additive
(`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`) and run lazily on first
request — same pattern the existing `buddies` table uses.

**When changing the WS protocol:** `server.js` (Railway) and `script.js`
(Bluehost) must ship together. Deploy server.js first (it ignores unknown
inbound types), then upload `script.js` once Railway is healthy.

---

## Risk & rollback notes

- **DB migrations are additive only.** Never `DROP` a column or table without a backup of `chatrooms.db` first.
- **Game state lives on Railway in memory** — same caveat as DMs today. A Railway restart kills in-progress games. Persisting active games to SQLite is a Phase 4 stretch goal if it becomes a real complaint.
- **The HMAC `WS_SECRET` flow stays unchanged.** Don't touch `mint_ws_token` / `verifyToken` while adding games — game messages ride the existing authenticated socket.
- **Bluehost shared-hosting limits.** Uploaded buddy icons (Phase 3.2) eat disk; cap at 64×64 PNG (~5 KB) and consider periodic cleanup of icons whose owners haven't logged in for 90 days.
- **CSRF for new POST endpoints.** Every new POST in `backend.php` must call `require_csrf()` — copy the pattern from `add-buddy`.

---

## Suggested order if you only ship Phase 1+2

If time is tight, **Phase 1 + Phase 2 alone delivers the brief** (challenge a
buddy to TTT or RPS). Phases 3 and 4 are polish + expansion; they can land any
time after that, in any order, in any subset.

🚀 *Happy hacking, and welcome back to 1995.*
