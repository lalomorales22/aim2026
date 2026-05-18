/**
 * Tests for the Tic Tac Toe GameSpec in lib/core.js.
 *
 * Server is the authority — anything that should be illegal must be rejected
 * by validateMove regardless of what the client sends. These tests cover:
 *   - all 8 win lines (3 rows, 3 cols, 2 diagonals) detect a winner
 *   - a full board with no win produces a draw
 *   - illegal moves are rejected (wrong turn, occupied cell, out of range,
 *     after game-over, bad payload shape)
 *   - winner() returns the winning *nickname* (not the X/O symbol)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tttSpec, makeTttInitialState, TTT_WIN_LINES } = require('../lib/core');

// Helper: deterministic start. xFirst is always 'alice' so we don't depend
// on Math.random() in tests.
function startGame() {
  return makeTttInitialState({ players: ['alice', 'bob'], xFirst: 'alice' });
}

// Helper: apply a sequence of [nick, cell] moves, returning the final state.
// Throws if any move would be rejected by validateMove (catches accidental
// bugs in test setup).
function play(state, moves) {
  let s = state;
  for (const [nick, cell] of moves) {
    if (!tttSpec.validateMove(s, nick, { cell })) {
      throw new Error(`test move rejected: ${nick} -> ${cell}\nstate: ${JSON.stringify(s)}`);
    }
    s = tttSpec.applyMove(s, nick, { cell });
  }
  return s;
}

test('TTT: initialState assigns X to the requested player', () => {
  const s = makeTttInitialState({ players: ['alice', 'bob'], xFirst: 'alice' });
  assert.equal(s.xPlayer, 'alice');
  assert.equal(s.oPlayer, 'bob');
  assert.equal(s.turn, 'X');
  assert.deepEqual(s.board, Array(9).fill(null));
  assert.equal(s.winner, null);
});

test('TTT: validateMove rejects bad payload shapes', () => {
  const s = startGame();
  assert.equal(tttSpec.validateMove(s, 'alice', null), false);
  assert.equal(tttSpec.validateMove(s, 'alice', {}), false);
  assert.equal(tttSpec.validateMove(s, 'alice', { cell: '0' }), false);     // string, not number
  assert.equal(tttSpec.validateMove(s, 'alice', { cell: 1.5 }), false);     // non-integer
  assert.equal(tttSpec.validateMove(s, 'alice', { cell: -1 }), false);       // out of range
  assert.equal(tttSpec.validateMove(s, 'alice', { cell: 9 }), false);        // out of range
});

test('TTT: validateMove rejects out-of-turn move', () => {
  const s = startGame();
  // Alice is X and moves first; Bob trying first should be rejected.
  assert.equal(tttSpec.validateMove(s, 'bob', { cell: 0 }), false);
  assert.equal(tttSpec.validateMove(s, 'alice', { cell: 0 }), true);
});

test('TTT: validateMove rejects an occupied cell', () => {
  const s = tttSpec.applyMove(startGame(), 'alice', { cell: 4 });
  assert.equal(tttSpec.validateMove(s, 'bob', { cell: 4 }), false);
  assert.equal(tttSpec.validateMove(s, 'bob', { cell: 5 }), true);
});

test('TTT: validateMove rejects all moves after a win', () => {
  // alice wins top row: X X X / O O . / . . .
  const final = play(startGame(), [
    ['alice', 0], ['bob', 3],
    ['alice', 1], ['bob', 4],
    ['alice', 2],
  ]);
  assert.equal(final.winner, 'alice');
  assert.equal(tttSpec.validateMove(final, 'bob', { cell: 8 }), false);
});

test('TTT: detects winner on every one of the 8 win lines', () => {
  // For each win line, build a game where 'alice' (X) plays into it and
  // 'bob' (O) plays into the leftover cells without blocking. The minimal
  // forced sequence is: alice plays the 3 cells of the line; bob plays
  // 2 non-line cells in between.
  for (const line of TTT_WIN_LINES) {
    const otherCells = [0,1,2,3,4,5,6,7,8].filter(c => !line.includes(c));
    const moves = [
      ['alice', line[0]],
      ['bob',   otherCells[0]],
      ['alice', line[1]],
      ['bob',   otherCells[1]],
      ['alice', line[2]],
    ];
    const s = play(startGame(), moves);
    assert.equal(s.winner, 'alice', `expected alice to win on line ${line.join(',')}`);
    assert.deepEqual(s.winningLine, line);
    assert.equal(tttSpec.isOver(s), true);
    assert.equal(tttSpec.winner(s), 'alice');
  }
});

test('TTT: full board with no win is a draw', () => {
  // Classic cats-game sequence — board fills, nobody wins:
  //   X O X
  //   X X O
  //   O X O
  const s = play(startGame(), [
    ['alice', 0], ['bob', 1],
    ['alice', 2], ['bob', 5],
    ['alice', 3], ['bob', 6],
    ['alice', 4], ['bob', 8],
    ['alice', 7],
  ]);
  assert.equal(s.winner, null);
  assert.equal(tttSpec.isOver(s), true);
  assert.equal(tttSpec.winner(s), null);
  assert.ok(s.board.every(c => c !== null), 'board should be full');
});

test('TTT: applyMove returns a NEW state object (no mutation)', () => {
  const s1 = startGame();
  const s2 = tttSpec.applyMove(s1, 'alice', { cell: 4 });
  assert.notStrictEqual(s1, s2);
  assert.notStrictEqual(s1.board, s2.board);
  assert.equal(s1.board[4], null);  // original untouched
  assert.equal(s2.board[4], 'X');
});

test('TTT: publicState is the full state (no hidden info)', () => {
  const s = startGame();
  assert.deepEqual(tttSpec.publicState(s, 'alice'), s);
  assert.deepEqual(tttSpec.publicState(s, 'bob'), s);
});

test('TTT: turn alternates X→O→X', () => {
  let s = startGame();
  assert.equal(s.turn, 'X');
  s = tttSpec.applyMove(s, 'alice', { cell: 0 });
  assert.equal(s.turn, 'O');
  s = tttSpec.applyMove(s, 'bob', { cell: 4 });
  assert.equal(s.turn, 'X');
});

test('TTT: winner() returns nickname, not symbol', () => {
  const s = play(startGame(), [
    ['alice', 0], ['bob', 3],
    ['alice', 1], ['bob', 4],
    ['alice', 2],
  ]);
  // alice played X. winner should be 'alice', not 'X'.
  assert.equal(tttSpec.winner(s), 'alice');
});
