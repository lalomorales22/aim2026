/**
 * WebSocket server for chat.laloadrianmorales.com
 * Designed to run on Railway. Pairs with the PHP frontend on Bluehost.
 *
 * Wire protocol (mirrors what script.js sends/expects):
 *   in:  identify | update_profile | join | message | typing
 *        direct_message | direct_typing | get_direct_messages
 *        game_invite | game_accept | game_decline | game_move | game_resign | game_chat
 *   out: message | join | leave | typing | active_users
 *        direct_message | direct_message_sent | direct_message_history | direct_typing
 *        game_invite | game_accept | game_decline | game_state | game_over | game_chat | game_error
 *        error
 *
 * Pure helpers (auth, dmKey, game registry, invite validation) live in lib/core.js
 * so they're testable without booting the HTTP server.
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const {
  makeVerifyToken,
  dmKey,
  idKey,
  newGameId,
  getGameSpec,
  validateInvite,
  makeGameEntry,
  findStaleGames,
} = require('./lib/core');

const PORT = process.env.PORT || 8080;
const ACTIVE_USERS_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const GAME_GC_INTERVAL_MS = 5 * 60_000;
const DM_HISTORY_LIMIT = 200;

// Grace period after a player's WS drops before their active games auto-forfeit.
// Keeps "I refreshed the tab" from costing the game; long disconnects still
// release the opponent.
const GAME_RECONNECT_GRACE_MS = 60_000;
const GAME_RECONNECT_CHECK_MS = 15_000;

// At most one away auto-reply per (recipient → sender) per this window so
// a chatty sender doesn't trigger 50 auto-replies in a row.
const AWAY_REPLY_THROTTLE_MS = 5 * 60_000;

const WS_SECRET = process.env.WS_SECRET || null;

// Bluehost backend URL — used to persist DMs through to SQLite so they
// survive Railway redeploys. BACKEND_API_TOKEN must be set on BOTH this
// host AND in .aim-env.php on Bluehost; if either is missing we just skip
// the persistence call and log once.
const BACKEND_URL = process.env.BACKEND_URL || 'https://chat.laloadrianmorales.com';
const BACKEND_API_TOKEN = process.env.BACKEND_API_TOKEN || null;

if (!WS_SECRET) {
  console.warn('[ws] WS_SECRET not set — accepting unsigned ".dev" tokens. Set WS_SECRET in Railway to lock this down.');
}
if (!BACKEND_API_TOKEN) {
  console.warn('[ws] BACKEND_API_TOKEN not set — DM history will NOT persist to Bluehost. Set BACKEND_API_TOKEN on both Railway and .aim-env.php to enable.');
}

const verifyToken = makeVerifyToken(WS_SECRET);

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

// nickname is the only identity. Last writer wins on metadata.
const clients = new Map();      // ws -> { nickname, displayName, status, avatarColor, profile, rooms:Set<roomId>, games:Set<gameId>, isAlive }
const roomMembers = new Map();  // roomId -> Set<ws>
const dmHistory = new Map();    // "alice|bob" (sorted) -> [{ from, to, message, timestamp }]
const games = new Map();        // gameId -> entry from makeGameEntry()

function members(roomId) {
  const key = idKey(roomId);
  if (key == null) return new Set();
  let set = roomMembers.get(key);
  if (!set) { set = new Set(); roomMembers.set(key, set); }
  return set;
}

function rosterPayload() {
  const seen = new Map();
  for (const c of clients.values()) {
    if (!c.nickname) continue;
    // Invisible status hides the user from the roster entirely (Phase 3.1).
    if (c.status === 'invisible') continue;
    seen.set(c.nickname, {
      nickname: c.nickname,
      displayName: c.displayName || c.nickname,
      status: c.status || 'online',
      avatarColor: c.avatarColor || '#007BFF',
      avatarIcon: (c.profile && c.profile.avatarIcon) || null,
    });
  }
  return { type: 'active_users', users: Array.from(seen.values()) };
}

function broadcastAll(payload) {
  const json = JSON.stringify(payload);
  for (const ws of clients.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(json);
  }
}

function broadcastToRoom(roomId, payload, exceptWs = null) {
  const json = JSON.stringify(payload);
  for (const ws of members(roomId)) {
    if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(json);
  }
}

function findByNickname(nickname) {
  for (const [ws, c] of clients) if (c.nickname === nickname) return ws;
  return null;
}

function sendTo(nickname, payload) {
  const ws = findByNickname(nickname);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Bluehost persistence — fire-and-forget HTTPS POSTs back to backend.php
// ---------------------------------------------------------------------------

// Persist a DM (or game receipt) to Bluehost so it survives a Railway
// redeploy. Failures are logged but never block the realtime fanout.
async function persistDm({ sender, recipient, message, messageType = 'text', payload = null }) {
  if (!BACKEND_API_TOKEN) return; // silently no-op until configured
  try {
    const res = await fetch(`${BACKEND_URL}/backend.php?endpoint=save-dm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': BACKEND_API_TOKEN,
      },
      body: JSON.stringify({
        sender, recipient,
        message: message ?? '',
        message_type: messageType,
        payload,
      }),
    });
    if (!res.ok) {
      console.warn(`[persist] save-dm responded ${res.status} for ${sender}->${recipient}`);
    }
  } catch (err) {
    console.warn(`[persist] save-dm failed for ${sender}->${recipient}:`, err.message);
  }
}

// Persist a finished game's outcome to the game_results table so the W/L
// chip on the profile reflects it. Fire-and-forget like persistDm.
async function persistGameResult({ gameType, players, winner, durationSec }) {
  if (!BACKEND_API_TOKEN) return;
  const [a, b] = players;
  try {
    const res = await fetch(`${BACKEND_URL}/backend.php?endpoint=save-game-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': BACKEND_API_TOKEN,
      },
      body: JSON.stringify({
        game_type: gameType,
        player_a: a, player_b: b,
        winner: winner || null,
        duration_seconds: durationSec ?? null,
      }),
    });
    if (!res.ok) {
      console.warn(`[persist] save-game-result responded ${res.status} for ${a} vs ${b}`);
    }
  } catch (err) {
    console.warn(`[persist] save-game-result failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Game routing — Phase 1 scaffolding; Phase 2 fills in GAME_REGISTRY
// ---------------------------------------------------------------------------

function gameError(ws, gameId, reason) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: 'game_error', gameId, reason }));
}

function touchGame(entry) {
  entry.lastActivityAt = Date.now();
}

// Send game state to every player in the game, after stripping any
// information they're not allowed to see (e.g. RPS opponent's pick before
// reveal). Uses the spec's publicState() if registered, otherwise sends
// the raw state. Phase 4.3 also fans out to spectators (entry.spectators).
function broadcastGameState(entry, kind = 'game_state') {
  const spec = getGameSpec(entry.gameType);
  // Players first.
  for (const nick of entry.players) {
    const ws = findByNickname(nick);
    if (!ws || ws.readyState !== ws.OPEN) continue;
    const view = spec && entry.state
      ? spec.publicState(entry.state, nick)
      : entry.state;
    ws.send(JSON.stringify({
      type: kind,
      gameId: entry.gameId,
      gameType: entry.gameType,
      players: entry.players,
      status: entry.status,
      winner: entry.winner,
      state: view,
    }));
  }
  // Spectators: pass a viewer string that no GameSpec recognizes so
  // publicState() hides hidden info from them too. For RPS this means
  // current-round picks stay hidden; for Hangman, the word stays hidden.
  if (entry.spectators) {
    for (const ws of entry.spectators) {
      if (ws.readyState !== ws.OPEN) continue;
      const view = spec && entry.state
        ? spec.publicState(entry.state, '__spectator__')
        : entry.state;
      ws.send(JSON.stringify({
        type: kind,
        gameId: entry.gameId,
        gameType: entry.gameType,
        players: entry.players,
        status: entry.status,
        winner: entry.winner,
        state: view,
        spectating: true,
      }));
    }
  }
}

function endGame(entry, winner) {
  if (entry.status === 'over') return;  // idempotent — disconnect + GC can race
  entry.status = 'over';
  entry.winner = winner;
  entry.endedAt = Date.now();
  touchGame(entry);
  broadcastGameState(entry, 'game_over');
  // Persist a game-result receipt to both DM threads so it shows up in the
  // archive, AND insert a row in game_results for the W/L chip.
  const [a, b] = entry.players;
  const durationSec = entry.startedAt
    ? Math.round((entry.endedAt - entry.startedAt) / 1000)
    : null;
  persistDm({
    sender: a, recipient: b,
    message: winner ? `${winner} won ${entry.gameType}` : `${entry.gameType} ended in a draw`,
    messageType: 'game_result',
    payload: { gameId: entry.gameId, gameType: entry.gameType, winner },
  });
  persistGameResult({
    gameType: entry.gameType,
    players: entry.players,
    winner,
    durationSec,
  });
}

// Re-send the current game state to a single player. Used when a player
// reconnects mid-game so their UI restores cleanly.
function resendGameState(entry, nickname) {
  const ws = findByNickname(nickname);
  if (!ws || ws.readyState !== ws.OPEN) return;
  const spec = getGameSpec(entry.gameType);
  const view = spec && entry.state
    ? spec.publicState(entry.state, nickname)
    : entry.state;
  ws.send(JSON.stringify({
    type: entry.status === 'over' ? 'game_over' : 'game_state',
    gameId: entry.gameId,
    gameType: entry.gameType,
    players: entry.players,
    status: entry.status,
    winner: entry.winner,
    state: view,
    resumed: true,
  }));
}

// ---------------------------------------------------------------------------
// HTTP: healthcheck + minimal landing page so Railway's check passes
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime_seconds: Math.round(process.uptime()),
      connections: clients.size,
      rooms: Array.from(roomMembers.entries())
        .map(([id, set]) => ({ id, users: set.size }))
        .filter(r => r.users > 0),
      games: games.size,
    }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  clients.set(ws, { nickname: null, rooms: new Set(), games: new Set(), spectating: new Set() });
  console.log(`[ws] connect from ${req.socket.remoteAddress} (total=${clients.size})`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return ws.send(JSON.stringify({ type: 'error', message: 'invalid json' })); }

    const client = clients.get(ws);
    if (!client) return;

    switch (data.type) {
      case 'identify': {
        const verified = verifyToken(data.token);
        if (!verified) {
          ws.send(JSON.stringify({ type: 'error', message: 'invalid or expired auth token' }));
          console.log(`[ws] identify rejected (bad token) claim=${data.nickname}`);
          ws.close(1008, 'unauthorized');
          break;
        }
        if (verified.nickname !== data.nickname) {
          ws.send(JSON.stringify({ type: 'error', message: 'nickname does not match token' }));
          console.log(`[ws] identify rejected (mismatch) token=${verified.nickname} claim=${data.nickname}`);
          ws.close(1008, 'unauthorized');
          break;
        }
        client.nickname = verified.nickname;
        client.displayName = data.displayName || verified.nickname;
        client.status = data.status || 'online';
        client.avatarColor = data.avatarColor || '#007BFF';
        client.profile = data.profile || {};
        console.log(`[ws] identify ${client.nickname}`);
        broadcastAll(rosterPayload());

        // Reconnect support: scan any games this nick is a player in, clear
        // their disconnected-mark, register the game with the new ws, and
        // re-send the current state so their UI restores cleanly.
        for (const [gameId, entry] of games) {
          if (!entry.players.includes(client.nickname)) continue;
          if (entry.status === 'over' || entry.status === 'declined') continue;
          if (entry.disconnectedPlayers) {
            entry.disconnectedPlayers.delete(client.nickname);
          }
          client.games.add(gameId);
          resendGameState(entry, client.nickname);
          console.log(`[game] ${client.nickname} reconnected to ${gameId} (${entry.gameType})`);
        }
        break;
      }

      case 'update_profile': {
        if (data.nickname) client.nickname = data.nickname;
        if (data.displayName) client.displayName = data.displayName;
        if (data.status) client.status = data.status;
        if (data.avatarColor) client.avatarColor = data.avatarColor;
        if (data.profile) client.profile = data.profile;
        broadcastAll(rosterPayload());
        break;
      }

      case 'join': {
        const roomId = idKey(data.roomId);
        if (!roomId) break;
        if (data.nickname) client.nickname = data.nickname;
        members(roomId).add(ws);
        client.rooms.add(roomId);
        broadcastToRoom(roomId, {
          type: 'join',
          roomId,
          nickname: client.nickname,
          userCount: members(roomId).size,
        });
        break;
      }

      case 'message': {
        const roomId = idKey(data.roomId);
        let { message } = data;
        if (!roomId || !message) break;
        const fromNick = data.nickname || client.nickname || 'someone';

        // Phase 4.8 — /roll NdM dice. Server is the authority for the roll
        // so clients can't fake their result. NaN/out-of-range silently
        // falls through to the normal message path.
        const rollMatch = /^\s*\/roll\s+(\d{1,2})d(\d{1,3})\s*$/i.exec(
            typeof message === 'string' ? message : ''
        );
        if (rollMatch) {
          const n = parseInt(rollMatch[1], 10);
          const d = parseInt(rollMatch[2], 10);
          if (n > 0 && n <= 20 && d >= 2 && d <= 100) {
            const rolls = [];
            for (let i = 0; i < n; i++) {
              rolls.push(Math.floor(Math.random() * d) + 1);
            }
            const sum = rolls.reduce((a, b) => a + b, 0);
            message = JSON.stringify({
              text: `🎲 ${fromNick} rolled ${sum} on ${n}d${d} (${rolls.join(', ')})`,
              style: { italic: true, color: '#000080' },
            });
          }
        }

        broadcastToRoom(roomId, {
          type: 'message',
          roomId,
          nickname: fromNick,
          message,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'typing': {
        const roomId = idKey(data.roomId);
        if (!roomId) break;
        broadcastToRoom(roomId, {
          type: 'typing',
          roomId,
          nickname: data.nickname || client.nickname,
        }, ws);
        break;
      }

      case 'direct_message': {
        const { to, message } = data;
        if (!to || !message || !client.nickname) break;
        const timestamp = new Date().toISOString();
        const entry = { from: client.nickname, to, message, timestamp };
        const key = dmKey(client.nickname, to);
        let hist = dmHistory.get(key);
        if (!hist) { hist = []; dmHistory.set(key, hist); }
        hist.push(entry);
        if (hist.length > DM_HISTORY_LIMIT) hist.splice(0, hist.length - DM_HISTORY_LIMIT);

        const recipientWs = findByNickname(to);
        if (recipientWs && recipientWs.readyState === recipientWs.OPEN) {
          recipientWs.send(JSON.stringify({
            type: 'direct_message',
            from: client.nickname,
            message,
            timestamp,
          }));
        }
        ws.send(JSON.stringify({
          type: 'direct_message_sent',
          to,
          message,
          timestamp,
        }));

        // Persist to Bluehost so history survives Railway redeploys.
        // Fire-and-forget — failures don't block the live fanout above.
        persistDm({ sender: client.nickname, recipient: to, message });

        // Phase 3.1 — Away auto-reply. If the recipient is currently away
        // and has an away message set, push their away text back to the
        // sender as a synthetic DM. Throttled per (recipient -> sender) so
        // a back-and-forth doesn't spam auto-replies.
        const recipientClient = recipientWs ? clients.get(recipientWs) : null;
        if (recipientClient && recipientClient.status === 'away'
            && recipientClient.profile && recipientClient.profile.awayMessage) {
          if (!recipientClient.awayReplyAt) recipientClient.awayReplyAt = new Map();
          const lastSent = recipientClient.awayReplyAt.get(client.nickname) || 0;
          const now = Date.now();
          if (now - lastSent > AWAY_REPLY_THROTTLE_MS) {
            recipientClient.awayReplyAt.set(client.nickname, now);
            const autoTs = new Date().toISOString();
            ws.send(JSON.stringify({
              type: 'direct_message',
              from: to,
              message: recipientClient.profile.awayMessage,
              timestamp: autoTs,
              autoReply: true,
            }));
            persistDm({
              sender: to, recipient: client.nickname,
              message: recipientClient.profile.awayMessage,
              messageType: 'away_auto_reply',
            });
          }
        }
        break;
      }

      case 'direct_typing': {
        const { to } = data;
        if (!to || !client.nickname) break;
        const recipientWs = findByNickname(to);
        if (recipientWs && recipientWs.readyState === recipientWs.OPEN) {
          recipientWs.send(JSON.stringify({
            type: 'direct_typing',
            from: client.nickname,
          }));
        }
        break;
      }

      case 'get_direct_messages': {
        const other = data.with;
        if (!other || !client.nickname) break;
        const messages = dmHistory.get(dmKey(client.nickname, other)) || [];
        ws.send(JSON.stringify({
          type: 'direct_message_history',
          with: other,
          messages,
        }));
        break;
      }

      // -------------------------------------------------------------------
      // Game framework — Phase 1 plumbing. Phase 2 registers GameSpecs in
      // lib/core.js's GAME_REGISTRY and these handlers immediately work
      // end-to-end without further server changes.
      // -------------------------------------------------------------------

      case 'game_invite': {
        const v = validateInvite(data, client.nickname);
        if (!v.ok) {
          gameError(ws, data && data.gameId, v.error);
          break;
        }
        const { to, gameType, gameId } = v.normalized;
        if (games.has(gameId)) {
          gameError(ws, gameId, 'gameId already in use');
          break;
        }
        const entry = makeGameEntry({
          gameId, gameType,
          players: [client.nickname, to],
          status: 'pending',
        });
        games.set(gameId, entry);
        client.games.add(gameId);

        // Receipt to sender (so their UI can show "invite sent").
        ws.send(JSON.stringify({
          type: 'game_invite', direction: 'outbound',
          gameId, gameType, to, from: client.nickname,
        }));
        // Push to recipient if online; otherwise the invite just sits in DM
        // history (persisted below) until they come back.
        sendTo(to, {
          type: 'game_invite', direction: 'inbound',
          gameId, gameType, to, from: client.nickname,
        });

        // Drop a receipt in the DM thread so the invite shows up in the
        // persistent message archive too.
        persistDm({
          sender: client.nickname, recipient: to,
          message: `${client.nickname} wants to play ${gameType}`,
          messageType: 'game_invite',
          payload: { gameId, gameType },
        });

        console.log(`[game] invite ${client.nickname} -> ${to} (${gameType}, id=${gameId})`);
        break;
      }

      case 'game_accept': {
        const gameId = idKey(data && data.gameId);
        const entry = gameId ? games.get(gameId) : null;
        if (!entry) { gameError(ws, gameId, 'unknown game'); break; }
        if (!entry.players.includes(client.nickname)) {
          gameError(ws, gameId, 'not a player in this game');
          break;
        }
        if (entry.status !== 'pending') {
          gameError(ws, gameId, `game is ${entry.status}, not pending`);
          break;
        }
        const spec = getGameSpec(entry.gameType);
        if (!spec) {
          // No spec registered for this gameType — friendly "coming soon".
          entry.status = 'over';
          entry.winner = null;
          gameError(ws, gameId,
            `${entry.gameType} is not playable yet — register a GameSpec in lib/core.js`);
          for (const nick of entry.players) {
            sendTo(nick, { type: 'game_error', gameId, reason: 'game type not yet implemented' });
          }
          break;
        }
        entry.status = 'active';
        entry.state = spec.initialState({ players: entry.players });
        entry.startedAt = Date.now();
        touchGame(entry);
        for (const nick of entry.players) {
          sendTo(nick, {
            type: 'game_accept',
            gameId,
            gameType: entry.gameType,
            players: entry.players,
            from: client.nickname,
          });
        }
        broadcastGameState(entry);
        console.log(`[game] accepted ${gameId} (${entry.gameType})`);
        break;
      }

      case 'game_decline': {
        const gameId = idKey(data && data.gameId);
        const entry = gameId ? games.get(gameId) : null;
        if (!entry) { gameError(ws, gameId, 'unknown game'); break; }
        if (!entry.players.includes(client.nickname)) {
          gameError(ws, gameId, 'not a player in this game');
          break;
        }
        entry.status = 'declined';
        touchGame(entry);
        for (const nick of entry.players) {
          sendTo(nick, { type: 'game_decline', gameId, from: client.nickname });
        }
        games.delete(gameId);
        console.log(`[game] declined ${gameId} by ${client.nickname}`);
        break;
      }

      case 'game_move': {
        const gameId = idKey(data && data.gameId);
        const entry = gameId ? games.get(gameId) : null;
        if (!entry) { gameError(ws, gameId, 'unknown game'); break; }
        if (entry.status !== 'active') {
          gameError(ws, gameId, `game is ${entry.status}, not active`);
          break;
        }
        if (!entry.players.includes(client.nickname)) {
          gameError(ws, gameId, 'not a player in this game');
          break;
        }
        const spec = getGameSpec(entry.gameType);
        if (!spec) {
          gameError(ws, gameId, 'game type not implemented');
          break;
        }
        if (!spec.validateMove(entry.state, client.nickname, data.move)) {
          gameError(ws, gameId, 'illegal move');
          break;
        }
        entry.state = spec.applyMove(entry.state, client.nickname, data.move);
        touchGame(entry);
        if (spec.isOver(entry.state)) {
          endGame(entry, spec.winner(entry.state));
        } else {
          broadcastGameState(entry);
        }
        break;
      }

      case 'game_resign': {
        const gameId = idKey(data && data.gameId);
        const entry = gameId ? games.get(gameId) : null;
        if (!entry) { gameError(ws, gameId, 'unknown game'); break; }
        if (!entry.players.includes(client.nickname)) {
          gameError(ws, gameId, 'not a player in this game');
          break;
        }
        if (entry.status !== 'active' && entry.status !== 'pending') {
          gameError(ws, gameId, `game is ${entry.status}`);
          break;
        }
        const opponent = entry.players.find(n => n !== client.nickname) || null;
        endGame(entry, opponent);
        console.log(`[game] resign ${gameId} by ${client.nickname}, winner=${opponent}`);
        break;
      }

      case 'request_roster': {
        // Phase 5 fix — manual "Refresh" button in the Buddy List. Sends the
        // current roster only to the requester instead of broadcasting to
        // everyone. Cheap, no flicker. (The periodic broadcast still runs
        // every ACTIVE_USERS_INTERVAL_MS so a missing client gets pushed
        // an update without doing anything.)
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(rosterPayload()));
        }
        break;
      }

      case 'list_active_games': {
        // Phase 4.3 — used by the Spectate Games window. Returns games in
        // 'active' status with player nicknames. Spectators don't see games
        // they're already a player in (they'd just open the live one).
        const list = [];
        for (const entry of games.values()) {
          if (entry.status !== 'active') continue;
          if (entry.players.includes(client.nickname)) continue;
          list.push({
            gameId: entry.gameId,
            gameType: entry.gameType,
            players: entry.players,
            startedAt: entry.startedAt || null,
          });
        }
        ws.send(JSON.stringify({ type: 'active_games_list', games: list }));
        break;
      }

      case 'game_spectate': {
        // Phase 4.3 — attach this socket as a read-only viewer. The game
        // must exist + be active. Disallow players adding themselves as
        // spectators of their own game.
        const gameId = idKey(data && data.gameId);
        const entry = gameId ? games.get(gameId) : null;
        if (!entry) { gameError(ws, gameId, 'unknown game'); break; }
        if (entry.players.includes(client.nickname)) {
          gameError(ws, gameId, "can't spectate your own game");
          break;
        }
        if (entry.status !== 'active') {
          gameError(ws, gameId, `game is ${entry.status}, not active`);
          break;
        }
        if (!entry.spectators) entry.spectators = new Set();
        entry.spectators.add(ws);
        if (!client.spectating) client.spectating = new Set();
        client.spectating.add(gameId);
        // Immediately send current state so the spectator window paints.
        const spec = getGameSpec(entry.gameType);
        const view = spec && entry.state
          ? spec.publicState(entry.state, '__spectator__')
          : entry.state;
        ws.send(JSON.stringify({
          type: 'game_state',
          gameId: entry.gameId,
          gameType: entry.gameType,
          players: entry.players,
          status: entry.status,
          winner: entry.winner,
          state: view,
          spectating: true,
          resumed: true,
        }));
        console.log(`[game] ${client.nickname} spectating ${gameId}`);
        break;
      }

      case 'game_unspectate': {
        const gameId = idKey(data && data.gameId);
        const entry = gameId ? games.get(gameId) : null;
        if (entry && entry.spectators) entry.spectators.delete(ws);
        if (client.spectating) client.spectating.delete(gameId);
        break;
      }

      case 'game_chat': {
        const gameId = idKey(data && data.gameId);
        const entry = gameId ? games.get(gameId) : null;
        if (!entry) { gameError(ws, gameId, 'unknown game'); break; }
        if (!entry.players.includes(client.nickname)) {
          gameError(ws, gameId, 'not a player in this game');
          break;
        }
        const message = typeof data.message === 'string' ? data.message.slice(0, 500) : '';
        if (!message) break;
        touchGame(entry);
        for (const nick of entry.players) {
          sendTo(nick, {
            type: 'game_chat',
            gameId,
            from: client.nickname,
            message,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: `unknown type: ${data.type}` }));
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      for (const roomId of client.rooms) {
        const set = members(roomId);
        set.delete(ws);
        broadcastToRoom(roomId, {
          type: 'leave',
          roomId,
          nickname: client.nickname,
          userCount: set.size,
        });
        if (set.size === 0) roomMembers.delete(roomId);
      }
      // Drop this ws from any spectator sets so we don't broadcast to a
      // dead socket. (Player disconnects are handled separately below.)
      if (client.spectating) {
        for (const gameId of client.spectating) {
          const entry = games.get(gameId);
          if (entry && entry.spectators) entry.spectators.delete(ws);
        }
      }
      // Disconnect handling for games is split by status:
      //   - 'pending': nothing started, just drop the invite so the inviter
      //     can challenge again. No forfeit, no penalty.
      //   - 'active':  start a reconnect grace timer instead of forfeiting
      //     immediately. checkDisconnectedGames() collects forfeits later.
      for (const gameId of client.games) {
        const entry = games.get(gameId);
        if (!entry || entry.status === 'over') continue;
        if (entry.status === 'pending') {
          for (const nick of entry.players) {
            sendTo(nick, { type: 'game_decline', gameId, from: client.nickname, reason: 'disconnect' });
          }
          games.delete(gameId);
          continue;
        }
        if (entry.status === 'active' && client.nickname) {
          if (!entry.disconnectedPlayers) entry.disconnectedPlayers = new Map();
          entry.disconnectedPlayers.set(client.nickname, Date.now());
          touchGame(entry);
          // Let the opponent know the connection dropped so the UI can show
          // a "waiting for reconnect" hint instead of just stalling.
          const opponent = entry.players.find(n => n !== client.nickname);
          if (opponent) {
            sendTo(opponent, {
              type: 'game_state',
              gameId,
              gameType: entry.gameType,
              players: entry.players,
              status: entry.status,
              winner: entry.winner,
              state: getGameSpec(entry.gameType)
                ? getGameSpec(entry.gameType).publicState(entry.state, opponent)
                : entry.state,
              disconnectedPlayers: [client.nickname],
            });
          }
        }
      }
    }
    clients.delete(ws);
    broadcastAll(rosterPayload());
    console.log(`[ws] disconnect (total=${clients.size})`);
  });

  ws.on('error', (err) => console.error('[ws] socket error:', err.message));
});

setInterval(() => broadcastAll(rosterPayload()), ACTIVE_USERS_INTERVAL_MS);

// Drop sockets that stop responding to pings (kills zombies behind proxies)
setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);

// Garbage-collect stale games (no activity in 30 min). findStaleGames is
// pure and tested separately; here we just delete what it returns.
setInterval(() => {
  const stale = findStaleGames(games);
  for (const id of stale) {
    games.delete(id);
  }
  if (stale.length) console.log(`[game] gc removed ${stale.length} stale game(s)`);
}, GAME_GC_INTERVAL_MS);

// Disconnect grace check: any active game where a player has been gone
// longer than GAME_RECONNECT_GRACE_MS auto-forfeits to the opponent.
// Short-disconnect / page-refresh players reconnect before this fires.
setInterval(() => {
  const now = Date.now();
  for (const entry of games.values()) {
    if (entry.status !== 'active') continue;
    if (!entry.disconnectedPlayers || entry.disconnectedPlayers.size === 0) continue;
    for (const [nick, ts] of entry.disconnectedPlayers) {
      if (now - ts < GAME_RECONNECT_GRACE_MS) continue;
      const opponent = entry.players.find(n => n !== nick) || null;
      console.log(`[game] ${nick} did not reconnect within grace; forfeit to ${opponent}`);
      endGame(entry, opponent);
      break; // entry is now 'over'; move on
    }
  }
}, GAME_RECONNECT_CHECK_MS);

server.listen(PORT, () => {
  console.log(`aim-chat ws server listening on :${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
