/**
 * End-to-end smoke test for Phase 4.
 *
 * Run after starting a local server:
 *   PORT=8181 WS_SECRET=test-secret node server.js &
 *   node test/smoke-phase4.js
 *
 * Covers:
 *   1. Connect Four end-to-end (vertical 4-in-a-row win)
 *   2. Hangman end-to-end (picker submits word, guesser wins)
 *   3. /roll server-side dice broadcast
 *   4. Spectator: third party watches in-progress TTT
 *   5. list_active_games filters out the spectator's own games
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
    ws.on('message', (raw) => ws._inbox.push(JSON.parse(raw.toString())));
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
    console.log('=== Phase 4 smoke ===');

    // ---- 1. Connect Four end-to-end (vertical win) ----------------------
    const alice = await connect('alice');
    const bob   = await connect('bob');
    await wait(150);

    alice.send(JSON.stringify({ type: 'game_invite', to: 'bob', gameType: 'c4' }));
    const c4InviteBob = await expect(bob, m => m.type === 'game_invite' && m.direction === 'inbound' && m.gameType === 'c4', 'c4 invite');
    const c4Id = c4InviteBob.gameId;
    bob.send(JSON.stringify({ type: 'game_accept', gameId: c4Id }));
    await expect(alice, m => m.type === 'game_accept' && m.gameId === c4Id, 'c4 accept');

    const c4First = await expect(alice, m => m.type === 'game_state' && m.gameId === c4Id, 'c4 initial');
    await expect(bob, m => m.type === 'game_state' && m.gameId === c4Id, 'c4 initial bob');

    const redPlayer = c4First.state.redPlayer;
    const yellowPlayer = c4First.state.yellowPlayer;
    const redSock = redPlayer === 'alice' ? alice : bob;
    const yelSock = yellowPlayer === 'alice' ? alice : bob;
    const drop = (sock, col) => sock.send(JSON.stringify({ type: 'game_move', gameId: c4Id, move: { col } }));

    // Red wins vertically in col 3. Yellow plays col 4 each turn (no block).
    drop(redSock, 3);
    await expect(alice, m => m.type === 'game_state' && m.state.cols[3].length === 1, 'red drop 1');
    drop(yelSock, 4);
    await expect(alice, m => m.type === 'game_state' && m.state.cols[4].length === 1, 'yellow drop 1');
    drop(redSock, 3);
    await expect(alice, m => m.type === 'game_state' && m.state.cols[3].length === 2, 'red drop 2');
    drop(yelSock, 4);
    await expect(alice, m => m.type === 'game_state' && m.state.cols[4].length === 2, 'yellow drop 2');
    drop(redSock, 3);
    await expect(alice, m => m.type === 'game_state' && m.state.cols[3].length === 3, 'red drop 3');
    drop(yelSock, 4);
    await expect(alice, m => m.type === 'game_state' && m.state.cols[4].length === 3, 'yellow drop 3');
    drop(redSock, 3);  // winning vertical 4

    const c4Over = await expect(alice, m => m.type === 'game_over' && m.gameId === c4Id, 'c4 game_over');
    if (c4Over.winner !== redPlayer) {
        throw new Error(`c4 winner mismatch: expected ${redPlayer}, got ${c4Over.winner}`);
    }
    console.log(`✓ Connect Four winner = ${c4Over.winner} (${redPlayer} as Red)`);

    // Drain bob's game_over too
    await expect(bob, m => m.type === 'game_over' && m.gameId === c4Id, 'c4 game_over bob');

    // ---- 2. Hangman end-to-end ---------------------------------------------
    alice.send(JSON.stringify({ type: 'game_invite', to: 'bob', gameType: 'hangman' }));
    const hmInvite = await expect(bob, m => m.type === 'game_invite' && m.direction === 'inbound' && m.gameType === 'hangman', 'hangman invite');
    const hmId = hmInvite.gameId;
    bob.send(JSON.stringify({ type: 'game_accept', gameId: hmId }));
    await expect(alice, m => m.type === 'game_accept' && m.gameId === hmId, 'hm accept');

    // First game_state: alice is the picker (first in players).
    const hmInit = await expect(alice, m => m.type === 'game_state' && m.gameId === hmId, 'hm initial');
    if (hmInit.state.picker !== 'alice') throw new Error(`expected alice as picker, got ${hmInit.state.picker}`);
    if (hmInit.state.guesser !== 'bob') throw new Error(`expected bob as guesser, got ${hmInit.state.guesser}`);

    // Verify the guesser does NOT see the word before submission (the
    // word is the empty string in awaiting_word phase anyway).
    const hmInitBob = await expect(bob, m => m.type === 'game_state' && m.gameId === hmId, 'hm initial bob');
    if (hmInitBob.state.word) throw new Error('guesser saw word before submission');

    // alice submits the word
    alice.send(JSON.stringify({ type: 'game_move', gameId: hmId, move: { word: 'cat' } }));
    const hmAfterWord = await expect(bob, m => m.type === 'game_state' && m.gameId === hmId && m.state.phase === 'guessing', 'hm after word');
    if (hmAfterWord.state.word) throw new Error('guesser saw word after submission');
    if (hmAfterWord.state.mask !== '___') throw new Error(`expected mask '___', got '${hmAfterWord.state.mask}'`);
    console.log("✓ Hangman picker submitted word; guesser sees mask only");

    // bob guesses c, a, t — wins
    bob.send(JSON.stringify({ type: 'game_move', gameId: hmId, move: { letter: 'c' } }));
    await expect(bob, m => m.type === 'game_state' && m.state.mask === 'c__', 'hm c revealed');
    bob.send(JSON.stringify({ type: 'game_move', gameId: hmId, move: { letter: 'a' } }));
    await expect(bob, m => m.type === 'game_state' && m.state.mask === 'ca_', 'hm a revealed');
    bob.send(JSON.stringify({ type: 'game_move', gameId: hmId, move: { letter: 't' } }));
    const hmOver = await expect(bob, m => m.type === 'game_over' && m.gameId === hmId, 'hm game_over');
    if (hmOver.winner !== 'bob') throw new Error(`expected bob to win hangman, got ${hmOver.winner}`);
    // The full word is now revealed even to the guesser.
    if (hmOver.state.word !== 'cat') throw new Error('guesser does not see word after game-over');
    console.log(`✓ Hangman winner = ${hmOver.winner} (word revealed: ${hmOver.state.word})`);

    // ---- 3. /roll server-side dice -------------------------------------
    // Both join a room first.
    // We'll forge a room broadcast by using room id "999".
    alice.send(JSON.stringify({ type: 'join', roomId: 999 }));
    bob.send(JSON.stringify({ type: 'join', roomId: 999 }));
    await wait(100);
    // Drain join messages.
    while (alice._inbox.length) alice._inbox.shift();
    while (bob._inbox.length) bob._inbox.shift();

    alice.send(JSON.stringify({ type: 'message', roomId: 999, message: '/roll 2d6', nickname: 'alice' }));
    const rollMsg = await expect(bob, m => m.type === 'message' && m.roomId === '999', 'roll broadcast');
    // The message field should now be JSON-wrapped with italic style.
    const parsed = JSON.parse(rollMsg.message);
    if (!parsed.text.startsWith('🎲 alice rolled')) {
        throw new Error(`/roll output unexpected: ${parsed.text}`);
    }
    if (!parsed.style || !parsed.style.italic) {
        throw new Error('/roll output missing italic style');
    }
    console.log(`✓ /roll worked: ${parsed.text}`);

    // ---- 4. Spectator -------------------------------------------------
    const carol = await connect('carol');
    await wait(100);

    // alice + bob start a new TTT game so carol can spectate it.
    alice.send(JSON.stringify({ type: 'game_invite', to: 'bob', gameType: 'ttt' }));
    const tttInvite = await expect(bob, m => m.type === 'game_invite' && m.direction === 'inbound' && m.gameType === 'ttt', 'ttt invite for spectate');
    const tttId = tttInvite.gameId;
    bob.send(JSON.stringify({ type: 'game_accept', gameId: tttId }));
    await expect(alice, m => m.type === 'game_accept' && m.gameId === tttId, 'ttt accept for spectate');
    await expect(alice, m => m.type === 'game_state' && m.gameId === tttId, 'ttt initial');

    // carol queries the active games list — should include alice vs bob TTT.
    carol.send(JSON.stringify({ type: 'list_active_games' }));
    const carolList = await expect(carol, m => m.type === 'active_games_list', 'active games list');
    const tttRow = (carolList.games || []).find(g => g.gameId === tttId);
    if (!tttRow) throw new Error('carol did not see the TTT game in the active list');
    console.log(`✓ Spectator sees ${carolList.games.length} active game(s)`);

    // carol joins as spectator and should receive an initial game_state.
    carol.send(JSON.stringify({ type: 'game_spectate', gameId: tttId }));
    const carolView = await expect(carol, m => m.type === 'game_state' && m.gameId === tttId, 'carol spectator state');
    if (!carolView.spectating) throw new Error('spectating flag missing from carol view');
    console.log('✓ Spectator received initial game_state with spectating: true');

    // Spectator cannot move.
    carol.send(JSON.stringify({ type: 'game_move', gameId: tttId, move: { cell: 0 } }));
    const carolErr = await expect(carol, m => m.type === 'game_error', 'carol move rejected');
    console.log(`✓ Spectator move rejected: "${carolErr.reason}"`);

    // ---- 5. Spectator should NOT see games they're playing in -----------
    // Alice asks for the list while in the TTT game — should be empty
    // (alice is a player, not a spectator, of the only active game).
    while (alice._inbox.length) alice._inbox.shift();
    alice.send(JSON.stringify({ type: 'list_active_games' }));
    const aliceList = await expect(alice, m => m.type === 'active_games_list', 'alice active games');
    if ((aliceList.games || []).find(g => g.gameId === tttId)) {
        throw new Error('alice saw her own TTT game in spectator list');
    }
    console.log('✓ Players do not see their own games in spectator list');

    alice.close();
    bob.close();
    carol.close();
    console.log('\n=== ALL PHASE 4 SMOKE TESTS PASSED ===');
    setTimeout(() => process.exit(0), 100);
})().catch(err => {
    console.error('FAIL:', err);
    process.exit(1);
});
