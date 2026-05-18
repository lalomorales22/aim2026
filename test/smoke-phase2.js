/**
 * End-to-end smoke test for Phase 2.
 *
 * Not picked up by `npm test` (file name lacks the .test.js suffix) because
 * it needs a running server. Run manually:
 *
 *   PORT=8181 WS_SECRET=test-secret node server.js &        # in one shell
 *   node test/smoke-phase2.js                               # in another
 *
 * Plays:
 *   1. A full TTT game where 'alice' wins the top row.
 *   2. A rejected illegal move after the game ends.
 *   3. A full RPS best-of-3 where alice wins 2-0 (rock beats scissors twice).
 *   4. A reconnect: alice closes mid-RPS and identifies again — the new ws
 *      should receive a resumed game_state.
 */

'use strict';

const WebSocket = require('ws');
const path = require('path');
const { mintToken } = require(path.join('..', 'lib', 'core.js'));

const URL = process.env.SMOKE_URL || 'ws://localhost:8181';
const SECRET = process.env.SMOKE_SECRET || 'test-secret';

function connect(nick) {
  const ws = new WebSocket(URL);
  ws._inbox = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'active_users') return; // skip the roster noise
    ws._inbox.push(m);
  });
  return new Promise(resolve => {
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'identify',
        token: mintToken(SECRET, nick),
        nickname: nick,
        displayName: nick,
      }));
      resolve(ws);
    });
  });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function expect(ws, predicate, label, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      while (ws._inbox.length) {
        const m = ws._inbox.shift();
        if (predicate(m)) return resolve(m);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout waiting for ${label}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

(async () => {
  const alice = await connect('alice');
  const bob   = await connect('bob');
  await wait(150);

  // ---- TTT: whoever is X wins top row ------------------------------------
  console.log('=== TTT ===');
  alice.send(JSON.stringify({ type: 'game_invite', to: 'bob', gameType: 'ttt' }));
  const inviteToBob = await expect(bob, m => m.type === 'game_invite' && m.direction === 'inbound', 'invite to bob');
  const gameId = inviteToBob.gameId;
  console.log(`invite gameId=${gameId}`);

  bob.send(JSON.stringify({ type: 'game_accept', gameId }));
  await expect(alice, m => m.type === 'game_accept', 'accept echo');
  console.log('accept echoed');

  const firstState = await expect(alice, m => m.type === 'game_state' && m.gameId === gameId, 'initial state');
  const xPlayer = firstState.state.xPlayer;
  const oPlayer = firstState.state.oPlayer;
  console.log(`X = ${xPlayer}, O = ${oPlayer}`);
  await expect(bob, m => m.type === 'game_state' && m.gameId === gameId, 'bob initial state');

  // X wins top row regardless of who got X.
  const xSocket = xPlayer === 'alice' ? alice : bob;
  const oSocket = oPlayer === 'alice' ? alice : bob;
  const sendMove = (ws, cell) => ws.send(JSON.stringify({ type: 'game_move', gameId, move: { cell } }));

  sendMove(xSocket, 0);
  await expect(alice, m => m.type === 'game_state' && m.state.board[0] === 'X', 'after X plays 0');
  sendMove(oSocket, 3);
  await expect(alice, m => m.type === 'game_state' && m.state.board[3] === 'O', 'after O plays 3');
  sendMove(xSocket, 1);
  await expect(alice, m => m.type === 'game_state' && m.state.board[1] === 'X', 'after X plays 1');
  sendMove(oSocket, 4);
  await expect(alice, m => m.type === 'game_state' && m.state.board[4] === 'O', 'after O plays 4');
  sendMove(xSocket, 2);

  const aliceOver = await expect(alice, m => m.type === 'game_over' && m.gameId === gameId, 'alice game_over');
  const bobOver   = await expect(bob,   m => m.type === 'game_over' && m.gameId === gameId, 'bob game_over');
  console.log(`TTT winner=${aliceOver.winner} (expected ${xPlayer})`);
  if (aliceOver.winner !== xPlayer) throw new Error('wrong winner!');
  if (bobOver.winner !== xPlayer)   throw new Error('bob saw wrong winner!');
  console.log('TTT: PASS');

  alice.send(JSON.stringify({ type: 'game_move', gameId, move: { cell: 8 } }));
  const err = await expect(alice, m => m.type === 'game_error' && m.gameId === gameId, 'post-game error');
  console.log(`post-game illegal move correctly rejected: "${err.reason}"`);

  // ---- RPS: alice 2-0 win -------------------------------------------------
  console.log('=== RPS ===');
  alice.send(JSON.stringify({ type: 'game_invite', to: 'bob', gameType: 'rps' }));
  const rpsInvite = await expect(bob, m => m.type === 'game_invite' && m.direction === 'inbound' && m.gameType === 'rps', 'rps invite');
  const rpsId = rpsInvite.gameId;
  bob.send(JSON.stringify({ type: 'game_accept', gameId: rpsId }));
  await expect(alice, m => m.type === 'game_accept' && m.gameId === rpsId, 'rps accept');
  await expect(alice, m => m.type === 'game_state' && m.gameId === rpsId, 'rps initial state');
  await expect(bob,   m => m.type === 'game_state' && m.gameId === rpsId, 'rps initial state (bob)');

  // Round 1: alice rock vs bob scissors → alice wins
  alice.send(JSON.stringify({ type: 'game_move', gameId: rpsId, move: { pick: 'rock' } }));
  const bobAfterAlice = await expect(bob, m => m.type === 'game_state' && m.gameId === rpsId, 'rps bob after alice picked');
  if (bobAfterAlice.state.picks.alice !== '__hidden__') {
    throw new Error(`expected alice pick hidden, got ${bobAfterAlice.state.picks.alice}`);
  }
  console.log("alice's pick hidden from bob (as expected)");

  bob.send(JSON.stringify({ type: 'game_move', gameId: rpsId, move: { pick: 'scissors' } }));
  const round1Alice = await expect(alice, m => m.type === 'game_state' && m.state.history.length === 1, 'rps round 1 resolved');
  console.log(`rps round 1 scores: alice=${round1Alice.state.scores.alice} bob=${round1Alice.state.scores.bob}`);
  await expect(bob, m => m.type === 'game_state' && m.state.history.length === 1, 'rps round 1 (bob)');

  // Round 2: same picks → alice wins 2-0, game over
  alice.send(JSON.stringify({ type: 'game_move', gameId: rpsId, move: { pick: 'rock' } }));
  await expect(bob, m => m.type === 'game_state' && m.state.picks.alice === '__hidden__', 'rps round 2 alice hidden');
  bob.send(JSON.stringify({ type: 'game_move', gameId: rpsId, move: { pick: 'scissors' } }));

  const rpsAliceOver = await expect(alice, m => m.type === 'game_over' && m.gameId === rpsId, 'rps alice game_over');
  const rpsBobOver   = await expect(bob,   m => m.type === 'game_over' && m.gameId === rpsId, 'rps bob game_over');
  console.log(`RPS winner=${rpsAliceOver.winner} (expected alice)`);
  if (rpsAliceOver.winner !== 'alice') throw new Error('wrong RPS winner!');
  if (rpsBobOver.winner !== 'alice')   throw new Error('bob saw wrong RPS winner!');
  console.log('RPS: PASS');

  // ---- Reconnect mid-game -------------------------------------------------
  console.log('=== reconnect ===');
  alice.send(JSON.stringify({ type: 'game_invite', to: 'bob', gameType: 'rps' }));
  const rcInvite = await expect(bob, m => m.type === 'game_invite' && m.direction === 'inbound' && m.gameType === 'rps', 'rc invite');
  const rcId = rcInvite.gameId;
  bob.send(JSON.stringify({ type: 'game_accept', gameId: rcId }));
  await expect(alice, m => m.type === 'game_accept', 'rc accept');
  await expect(alice, m => m.type === 'game_state' && m.gameId === rcId, 'rc initial');
  await expect(bob,   m => m.type === 'game_state' && m.gameId === rcId, 'rc initial bob');

  alice.send(JSON.stringify({ type: 'game_move', gameId: rcId, move: { pick: 'rock' } }));
  await wait(100);
  alice.close();
  await wait(200);

  const alice2 = await connect('alice');
  const resumed = await expect(alice2, m => m.type === 'game_state' && m.gameId === rcId && m.resumed, 'resumed game_state');
  console.log(`reconnect ok — alice's pick still: ${resumed.state.picks.alice}`);
  if (resumed.state.picks.alice !== 'rock') throw new Error('lost alice pick on reconnect');

  alice2.close();
  bob.close();
  console.log('\n=== ALL SMOKE TESTS PASSED ===');
  setTimeout(() => process.exit(0), 100);
})().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
