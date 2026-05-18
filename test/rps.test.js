/**
 * Tests for the Rock Paper Scissors GameSpec in lib/core.js.
 *
 * Covers:
 *   - all 9 pair combinations resolve correctly (3 wins, 3 losses, 3 ties)
 *   - best-of-3 terminates when one player hits 2 wins
 *   - publicState hides the opponent's current pick until both have picked
 *   - validateMove rejects: bad payload, non-player, double pick, post-game
 *   - past picks (in history[]) are NOT hidden — they're already public
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  rpsSpec, makeRpsInitialState,
  RPS_OPTIONS, rpsRoundWinner,
} = require('../lib/core');

function startGame(maxRounds = 3) {
  return makeRpsInitialState({ players: ['alice', 'bob'], maxRounds });
}

// Helper: play out one round. Returns the resolved state.
function playRound(state, alicePick, bobPick) {
  let s = state;
  s = rpsSpec.applyMove(s, 'alice', { pick: alicePick });
  s = rpsSpec.applyMove(s, 'bob',   { pick: bobPick });
  return s;
}

// ---------------------------------------------------------------------------
// Round resolution (the 9 combos)
// ---------------------------------------------------------------------------

test('RPS: rock beats scissors, scissors beats paper, paper beats rock', () => {
  assert.equal(rpsRoundWinner('rock',     'scissors', 'a', 'b'), 'a');
  assert.equal(rpsRoundWinner('scissors', 'paper',    'a', 'b'), 'a');
  assert.equal(rpsRoundWinner('paper',    'rock',     'a', 'b'), 'a');

  assert.equal(rpsRoundWinner('scissors', 'rock',     'a', 'b'), 'b');
  assert.equal(rpsRoundWinner('paper',    'scissors', 'a', 'b'), 'b');
  assert.equal(rpsRoundWinner('rock',     'paper',    'a', 'b'), 'b');
});

test('RPS: matching picks tie (no winner)', () => {
  for (const pick of RPS_OPTIONS) {
    assert.equal(rpsRoundWinner(pick, pick, 'a', 'b'), null);
  }
});

// ---------------------------------------------------------------------------
// End-to-end best-of-3
// ---------------------------------------------------------------------------

test('RPS: best-of-3 ends as soon as one player hits 2 wins', () => {
  let s = startGame();
  // Round 1: alice rock vs bob scissors → alice wins (1-0)
  s = playRound(s, 'rock', 'scissors');
  assert.equal(s.scores.alice, 1);
  assert.equal(s.scores.bob, 0);
  assert.equal(rpsSpec.isOver(s), false);

  // Round 2: alice paper vs bob rock → alice wins (2-0) → over
  s = playRound(s, 'paper', 'rock');
  assert.equal(s.scores.alice, 2);
  assert.equal(rpsSpec.isOver(s), true);
  assert.equal(rpsSpec.winner(s), 'alice');
});

test('RPS: ties do not award points but do advance the round counter', () => {
  let s = startGame();
  s = playRound(s, 'rock', 'rock');     // tie
  assert.equal(s.scores.alice, 0);
  assert.equal(s.scores.bob, 0);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].winner, null);
  assert.equal(s.round, 2);

  s = playRound(s, 'rock', 'scissors');  // alice wins (1-0)
  s = playRound(s, 'rock', 'scissors');  // alice wins (2-0) → over
  assert.equal(rpsSpec.winner(s), 'alice');
});

test('RPS: best-of-3 can end 2-1 (no clean sweep)', () => {
  let s = startGame();
  s = playRound(s, 'rock', 'scissors');  // alice 1, bob 0
  s = playRound(s, 'scissors', 'rock');  // alice 1, bob 1
  s = playRound(s, 'paper', 'rock');     // alice 2, bob 1 → over
  assert.equal(rpsSpec.isOver(s), true);
  assert.equal(rpsSpec.winner(s), 'alice');
  assert.equal(s.history.length, 3);
});

test('RPS: maxRounds=3 with all ties terminates at 3 rounds with no winner', () => {
  // Edge case the spec calls out — best-of-3 with three straight ties.
  // Could happen in practice; needs to terminate so the UI can show "draw".
  let s = startGame();
  s = playRound(s, 'rock',     'rock');
  s = playRound(s, 'paper',    'paper');
  s = playRound(s, 'scissors', 'scissors');
  assert.equal(rpsSpec.isOver(s), true);
  assert.equal(rpsSpec.winner(s), null);
});

// ---------------------------------------------------------------------------
// Move validation
// ---------------------------------------------------------------------------

test('RPS: validateMove rejects bad payload shapes', () => {
  const s = startGame();
  assert.equal(rpsSpec.validateMove(s, 'alice', null), false);
  assert.equal(rpsSpec.validateMove(s, 'alice', {}), false);
  assert.equal(rpsSpec.validateMove(s, 'alice', { pick: 'lizard' }), false);
  assert.equal(rpsSpec.validateMove(s, 'alice', { pick: 'ROCK' }), false);  // case-sensitive
});

test('RPS: validateMove rejects non-player', () => {
  const s = startGame();
  assert.equal(rpsSpec.validateMove(s, 'eve', { pick: 'rock' }), false);
});

test('RPS: validateMove rejects double-pick in the same round', () => {
  let s = startGame();
  s = rpsSpec.applyMove(s, 'alice', { pick: 'rock' });
  // alice already picked, bob has not. alice trying again should be rejected.
  assert.equal(rpsSpec.validateMove(s, 'alice', { pick: 'paper' }), false);
  assert.equal(rpsSpec.validateMove(s, 'bob',   { pick: 'paper' }), true);
});

test('RPS: validateMove rejects moves after the game ends', () => {
  let s = startGame();
  s = playRound(s, 'rock', 'scissors');
  s = playRound(s, 'rock', 'scissors');
  assert.equal(rpsSpec.isOver(s), true);
  assert.equal(rpsSpec.validateMove(s, 'alice', { pick: 'rock' }), false);
});

// ---------------------------------------------------------------------------
// publicState — the hidden-pick reveal mechanism
// ---------------------------------------------------------------------------

test('RPS: publicState hides opponent current-round pick before reveal', () => {
  let s = startGame();
  s = rpsSpec.applyMove(s, 'alice', { pick: 'rock' });

  // alice's view: she sees her own pick.
  const aliceView = rpsSpec.publicState(s, 'alice');
  assert.equal(aliceView.picks.alice, 'rock');
  assert.equal(aliceView.picks.bob,   null);  // bob hasn't picked

  // bob's view: he hasn't picked, and alice's pick is hidden.
  const bobView = rpsSpec.publicState(s, 'bob');
  assert.equal(bobView.picks.bob,   null);
  assert.equal(bobView.picks.alice, '__hidden__');
});

test('RPS: publicState mutation safety — does not alter the source state', () => {
  let s = startGame();
  s = rpsSpec.applyMove(s, 'alice', { pick: 'rock' });
  const view = rpsSpec.publicState(s, 'bob');
  view.picks.alice = 'paper';     // try to tamper with the view
  assert.equal(s.picks.alice, 'rock');  // source unchanged
});

test('RPS: history records both picks so client can render reveal', () => {
  let s = startGame();
  s = playRound(s, 'rock', 'paper');
  assert.equal(s.history.length, 1);
  assert.deepEqual(s.history[0].picks, { alice: 'rock', bob: 'paper' });
  assert.equal(s.history[0].winner, 'bob');  // paper covers rock
  // After resolution, current-round picks reset.
  assert.equal(s.picks.alice, null);
  assert.equal(s.picks.bob,   null);
});

test('RPS: history of a finished round is NOT hidden by publicState', () => {
  // Once both players have revealed, history rows are public to both.
  let s = startGame();
  s = playRound(s, 'rock', 'paper');  // bob wins round 1
  s = rpsSpec.applyMove(s, 'alice', { pick: 'scissors' });

  const bobView = rpsSpec.publicState(s, 'bob');
  // Current round: alice picked but not bob — alice should be hidden from bob.
  assert.equal(bobView.picks.alice, '__hidden__');
  // But history is fully visible.
  assert.equal(bobView.history.length, 1);
  assert.deepEqual(bobView.history[0].picks, { alice: 'rock', bob: 'paper' });
});

test('RPS: applyMove returns a NEW state (no mutation)', () => {
  const s1 = startGame();
  const s2 = rpsSpec.applyMove(s1, 'alice', { pick: 'rock' });
  assert.notStrictEqual(s1, s2);
  assert.notStrictEqual(s1.picks, s2.picks);
  assert.equal(s1.picks.alice, null);  // original untouched
});
