/**
 * WebSocket server for chat.laloadrianmorales.com
 * Designed to run on Railway. Pairs with the PHP frontend on Bluehost.
 *
 * Wire protocol (mirrors what script.js sends/expects):
 *   in:  identify | update_profile | join | message | typing
 *        direct_message | direct_typing | get_direct_messages
 *   out: message | join | leave | typing | active_users
 *        direct_message | direct_message_sent | direct_message_history | direct_typing | error
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ACTIVE_USERS_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const DM_HISTORY_LIMIT = 200;

// nickname is the only identity. Last writer wins on metadata.
const clients = new Map();      // ws -> { nickname, displayName, status, avatarColor, profile, rooms:Set<roomId>, isAlive }
const roomMembers = new Map();  // roomId -> Set<ws>
const dmHistory = new Map();    // "alice|bob" (sorted) -> [{ from, to, message, timestamp }]

const dmKey = (a, b) => [a, b].sort().join('|');

function members(roomId) {
  let set = roomMembers.get(roomId);
  if (!set) { set = new Set(); roomMembers.set(roomId, set); }
  return set;
}

function rosterPayload() {
  const seen = new Map();
  for (const c of clients.values()) {
    if (!c.nickname) continue;
    seen.set(c.nickname, {
      nickname: c.nickname,
      displayName: c.displayName || c.nickname,
      status: c.status || 'online',
      avatarColor: c.avatarColor || '#007BFF',
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

// HTTP: healthcheck + minimal landing page so Railway's check passes
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
    }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  clients.set(ws, { nickname: null, rooms: new Set() });
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
        client.nickname = data.nickname;
        client.displayName = data.displayName || data.nickname;
        client.status = data.status || 'online';
        client.avatarColor = data.avatarColor || '#007BFF';
        client.profile = data.profile || {};
        console.log(`[ws] identify ${client.nickname}`);
        broadcastAll(rosterPayload());
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
        const { roomId } = data;
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
        const { roomId, message } = data;
        if (!roomId || !message) break;
        broadcastToRoom(roomId, {
          type: 'message',
          roomId,
          nickname: data.nickname || client.nickname,
          message,
          timestamp: new Date().toISOString(),
        });
        break;
      }

      case 'typing': {
        const { roomId } = data;
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

server.listen(PORT, () => {
  console.log(`aim-chat ws server listening on :${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
