/**
 * Tests for lib/core.js — the pure helpers shared with server.js.
 *
 * Run via `npm test` (which calls `node --test test/`).
 *
 * Phase 1 only ships the framework; Phase 2 will add per-GameSpec tests
 * (TTT win lines, RPS resolution table, …) into this same directory.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  makeVerifyToken,
  mintToken,
  dmKey,
  idKey,
  newGameId,
  registerGame,
  getGameSpec,
  validateInvite,
  makeGameEntry,
  findStaleGames,
} = require('../lib/core');

// ---------------------------------------------------------------------------
// Auth token round-trip
// ---------------------------------------------------------------------------

test('mintToken + verifyToken round-trip with a real secret', () => {
  const secret = 'super-secret-test-key';
  const verify = makeVerifyToken(secret);
  const tok = mintToken(secret, 'alice');
  const payload = verify(tok);
  assert.ok(payload, 'token should verify');
  assert.equal(payload.nickname, 'alice');
  assert.equal(typeof payload.exp, 'number');
});

test('verifyToken rejects a token signed with the wrong secret', () => {
  const verify = makeVerifyToken('right-secret');
  const tok = mintToken('wrong-secret', 'alice');
  assert.equal(verify(tok), null);
});

test('verifyToken rejects an expired token', () => {
  const secret = 'k';
  const verify = makeVerifyToken(secret);
  // Mint a token that expired 60s ago by passing a backdated `now`.
  const past = Math.floor(Date.now() / 1000) - 3600;
  const tok = mintToken(secret, 'bob', -60, past); // ttl=-60 means exp=past-60
  assert.equal(verify(tok), null);
});

test('verifyToken rejects garbage', () => {
  const verify = makeVerifyToken('k');
  assert.equal(verify(''), null);
  assert.equal(verify(null), null);
  assert.equal(verify('not.a.real.token'), null);
  assert.equal(verify('only-one-segment'), null);
});

test('dev-mode (no secret) accepts .dev tokens, rejects HMAC tokens', () => {
  const verify = makeVerifyToken(null);
  const devTok = mintToken(null, 'carol');
  assert.ok(devTok.endsWith('.dev'));
  assert.ok(verify(devTok));
  const realTok = mintToken('some-secret', 'carol');
  assert.equal(verify(realTok), null);
});

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

test('dmKey is order-independent', () => {
  assert.equal(dmKey('alice', 'bob'), dmKey('bob', 'alice'));
  assert.equal(dmKey('alice', 'bob'), 'alice|bob');
});

test('idKey normalizes number/string IDs the same way', () => {
  assert.equal(idKey(5), '5');
  assert.equal(idKey('5'), '5');
  assert.equal(idKey(null), null);
  assert.equal(idKey(undefined), null);
});

// ---------------------------------------------------------------------------
// Game framework
// ---------------------------------------------------------------------------

test('newGameId returns distinct URL-safe strings', () => {
  const a = newGameId();
  const b = newGameId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('registerGame validates the GameSpec interface', () => {
  assert.throws(() => registerGame('', {}), /non-empty string/);
  assert.throws(() => registerGame('bad', {}), /missing required function/);
  const stub = {
    initialState: () => ({}),
    validateMove: () => true,
    applyMove:    (s) => s,
    publicState:  (s) => s,
    isOver:       () => true,
    winner:       () => null,
  };
  registerGame('stub', stub);
  assert.equal(getGameSpec('stub'), stub);
});

test('validateInvite catches the obvious problems', () => {
  // Missing sender (not yet identified).
  assert.equal(validateInvite({ to: 'b', gameType: 'ttt' }, '').ok, false);

  // Missing to.
  assert.equal(validateInvite({ gameType: 'ttt' }, 'a').ok, false);

  // Missing gameType.
  assert.equal(validateInvite({ to: 'b' }, 'a').ok, false);

  // Self-challenge.
  assert.equal(validateInvite({ to: 'a', gameType: 'ttt' }, 'a').ok, false);

  // Happy path mints a gameId if none provided.
  const ok = validateInvite({ to: 'b', gameType: 'ttt' }, 'a');
  assert.equal(ok.ok, true);
  assert.equal(ok.normalized.to, 'b');
  assert.equal(ok.normalized.gameType, 'ttt');
  assert.ok(ok.normalized.gameId);

  // Provided gameId is preserved.
  const ok2 = validateInvite({ to: 'b', gameType: 'ttt', gameId: 'abc' }, 'a');
  assert.equal(ok2.normalized.gameId, 'abc');
});

test('makeGameEntry dedupes players and sets a sane default status', () => {
  const e = makeGameEntry({
    gameId: 'g1', gameType: 'ttt', players: ['a', 'b', 'a'],
  });
  assert.deepEqual(e.players, ['a', 'b']);
  assert.equal(e.status, 'pending');
  assert.equal(e.winner, null);
  assert.ok(e.createdAt > 0);
});

test('findStaleGames flags games past TTL and ignores fresh ones', () => {
  const now = 1_000_000;
  const games = new Map([
    ['fresh',     { lastActivityAt: now - 60_000 }],
    ['justAged',  { lastActivityAt: now - 31 * 60_000 }],
    ['ancient',   { lastActivityAt: now - 60 * 60_000 }],
  ]);
  const stale = findStaleGames(games, now, 30 * 60 * 1000);
  assert.deepEqual(stale.sort(), ['ancient', 'justAged']);
});
