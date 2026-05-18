/**
 * End-to-end smoke test for Phase 3 server-side behaviors.
 *
 * Not picked up by `npm test` (no .test.js suffix) — needs a running server:
 *   PORT=8181 WS_SECRET=test-secret node server.js &
 *   node test/smoke-phase3.js
 *
 * Covers:
 *   1. Away auto-reply: alice DMs bob while bob.status='away' with an
 *      awayMessage; alice should receive bob's away text as a DM.
 *   2. Auto-reply throttling: alice DMs bob a second time within the
 *      throttle window; she should NOT get a second auto-reply.
 *   3. Invisible status: alice sets status='invisible' and should disappear
 *      from bob's roster on the next active_users broadcast.
 *   4. avatarIcon in roster: a base64 PNG data URL placed on alice's
 *      profile should round-trip through the active_users broadcast.
 */

'use strict';

const WebSocket = require('ws');
const path = require('path');
const { mintToken } = require(path.join('..', 'lib', 'core.js'));

const URL = process.env.SMOKE_URL || 'ws://localhost:8181';
const SECRET = process.env.SMOKE_SECRET || 'test-secret';

function connect(nick, profile) {
    const ws = new WebSocket(URL);
    ws._inbox = [];
    ws.on('message', (raw) => {
        ws._inbox.push(JSON.parse(raw.toString()));
    });
    return new Promise(resolve => {
        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'identify',
                token: mintToken(SECRET, nick),
                nickname: nick,
                displayName: nick,
                status: (profile && profile.status) || 'online',
                avatarColor: '#007BFF',
                profile: profile || {},
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
    console.log('=== Phase 3 smoke ===');

    // ---- 1. Away auto-reply --------------------------------------------
    const bobAway = 'I am AFK, brb at 8! 🍕';
    const alice = await connect('alice');
    const bob   = await connect('bob', {
        status: 'away',
        awayMessage: bobAway,
    });
    // The connect helper already sent identify with status=away.
    await wait(150);

    alice.send(JSON.stringify({
        type: 'direct_message', to: 'bob', message: 'hey bob you around?',
    }));

    // Alice should receive: direct_message_sent (her echo) + a synthetic
    // direct_message containing bob's away text with autoReply: true.
    const echo = await expect(alice, m => m.type === 'direct_message_sent' && m.to === 'bob', 'dm echo');
    console.log(`alice's echo: "${echo.message}"`);
    const auto = await expect(alice, m => m.type === 'direct_message' && m.from === 'bob' && m.autoReply === true, 'auto-reply');
    if (auto.message !== bobAway) {
        throw new Error(`auto-reply text mismatch: ${auto.message}`);
    }
    console.log(`✓ auto-reply received: "${auto.message}"`);

    // ---- 2. Throttle: a second DM in the same window does NOT auto-reply ---
    alice.send(JSON.stringify({
        type: 'direct_message', to: 'bob', message: 'still around?',
    }));
    await wait(200);
    const secondAuto = alice._inbox.find(m =>
        m.type === 'direct_message' && m.from === 'bob' && m.autoReply === true
    );
    if (secondAuto) throw new Error('auto-reply throttle failed; received a second one');
    console.log('✓ auto-reply correctly throttled on rapid follow-up');

    alice.close();
    bob.close();
    await wait(150);

    // ---- 3. Invisible status hides from roster --------------------------
    const carol = await connect('carol', { status: 'invisible' });
    const dave  = await connect('dave',  { status: 'online' });
    await wait(150);

    // Dave should NOT see carol in his roster.
    // Wait for an active_users broadcast that lists at least dave.
    // (The server emits one on every identify + every 15s.)
    let saw = null;
    const start = Date.now();
    while (Date.now() - start < 2000) {
        const m = dave._inbox.find(m => m.type === 'active_users');
        if (m) { saw = m; break; }
        await wait(50);
    }
    if (!saw) throw new Error('no active_users broadcast received within 2s');
    const nicks = (saw.users || []).map(u => u.nickname);
    if (nicks.includes('carol')) {
        throw new Error(`invisible carol leaked into roster: ${JSON.stringify(nicks)}`);
    }
    if (!nicks.includes('dave')) {
        throw new Error(`dave missing from his own roster: ${JSON.stringify(nicks)}`);
    }
    console.log(`✓ invisible carol absent from roster; visible nicks = ${JSON.stringify(nicks)}`);

    carol.close();
    dave.close();
    await wait(150);

    // ---- 4. avatarIcon round-trips through roster ----------------------
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const eve   = await connect('eve',   { avatarIcon: tinyPng });
    const frank = await connect('frank', { status: 'online' });
    await wait(150);

    const frankRoster = await expect(frank, m => m.type === 'active_users', 'roster');
    const eveRow = (frankRoster.users || []).find(u => u.nickname === 'eve');
    if (!eveRow) throw new Error('eve missing from roster');
    if (eveRow.avatarIcon !== tinyPng) {
        throw new Error(`avatarIcon did not propagate; got: ${eveRow.avatarIcon}`);
    }
    console.log('✓ avatarIcon round-trips through roster');

    eve.close();
    frank.close();

    console.log('\n=== ALL PHASE 3 SMOKE TESTS PASSED ===');
    setTimeout(() => process.exit(0), 100);
})().catch(err => {
    console.error('FAIL:', err);
    process.exit(1);
});
