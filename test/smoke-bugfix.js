/**
 * Smoke test for the two reported bugs:
 *   1. Timezone — the test asserts the server returns ISO 8601 with explicit
 *      'Z' so the client's `new Date()` parses unambiguously as UTC.
 *      (Only verifies the WS side here — backend.php's HTTP responses are
 *      covered by the unit test for the helper, since backend.php needs
 *      PHP runtime + SQLite to test live.)
 *   2. Active users flicker — verifies `request_roster` works and returns
 *      a snapshot to the requester only (not a broadcast to everyone).
 *
 * Run with:
 *   PORT=8181 WS_SECRET=test-secret node server.js &
 *   node test/smoke-bugfix.js
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
    console.log('=== Bugfix smoke ===');

    const alice = await connect('alice');
    const bob   = await connect('bob');
    await wait(150);

    // ---- 1. Timezone — WS messages already use ISO 8601 with Z. -----------
    // Confirm by sending a DM and inspecting the timestamp shape.
    alice.send(JSON.stringify({ type: 'direct_message', to: 'bob', message: 'hi' }));
    const dm = await expect(bob, m => m.type === 'direct_message' && m.from === 'alice', 'dm');
    const ts = dm.timestamp;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(ts)) {
        throw new Error(`WS timestamp is not ISO-with-Z: ${ts}`);
    }
    // The JS Date parser must accept it and produce a sensible epoch.
    const parsed = new Date(ts);
    if (isNaN(parsed.getTime())) throw new Error(`WS timestamp does not parse: ${ts}`);
    console.log(`✓ WS DM timestamp is ISO-UTC: ${ts}`);
    console.log(`  parses to ${parsed.toISOString()} (epoch ${parsed.getTime()})`);

    // ---- 2. request_roster returns only to the requester. -----------------
    // Send request_roster from alice; assert alice gets active_users
    // payload AND bob does NOT see one within 200ms (the periodic
    // broadcast is every 15s, well outside our window).
    while (alice._inbox.length) alice._inbox.shift();
    while (bob._inbox.length) bob._inbox.shift();
    alice.send(JSON.stringify({ type: 'request_roster' }));
    const roster = await expect(alice, m => m.type === 'active_users', 'alice roster', 1000);
    if (!Array.isArray(roster.users)) throw new Error('roster has no users array');
    if (!roster.users.find(u => u.nickname === 'alice')) throw new Error('alice missing from her own roster');
    if (!roster.users.find(u => u.nickname === 'bob'))   throw new Error('bob missing from alice roster');
    console.log(`✓ request_roster returned ${roster.users.length} users to alice`);

    // Bob should NOT have received a new active_users — request_roster
    // is a one-shot reply to the requester, not a broadcast.
    await wait(250);
    const bobRoster = bob._inbox.find(m => m.type === 'active_users');
    if (bobRoster) {
        throw new Error('request_roster leaked into bob\'s inbox — should be requester-only');
    }
    console.log('✓ request_roster did not broadcast to bob');

    // ---- 3. Identify still pushes the roster on connect ------------------
    // The cold-start flow: a fresh client gets a roster within ~50ms of identify.
    const carol = await connect('carol');
    const carolRoster = await expect(carol, m => m.type === 'active_users', 'carol initial roster', 1000);
    if (!carolRoster.users.find(u => u.nickname === 'carol')) throw new Error('carol missing from initial roster');
    console.log(`✓ identify still pushes a roster: ${carolRoster.users.length} users`);

    alice.close();
    bob.close();
    carol.close();

    console.log('\n=== ALL BUGFIX SMOKE TESTS PASSED ===');
    setTimeout(() => process.exit(0), 100);
})().catch(err => {
    console.error('FAIL:', err);
    process.exit(1);
});
