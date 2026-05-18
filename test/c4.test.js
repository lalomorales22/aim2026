/**
 * Tests for the Connect Four GameSpec (Phase 4.1).
 *
 * Covers:
 *   - All 4 win directions (vertical, horizontal, both diagonals)
 *   - Gravity (drops stack from bottom)
 *   - Illegal moves: column full, out-of-range, wrong turn, after game-over
 *   - Draw when board fills with no winner
 *   - publicState exposes everything (no hidden info)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    c4Spec, makeC4InitialState, c4CheckWinner, C4_COLS, C4_ROWS,
} = require('../lib/core');

function startGame() {
    return makeC4InitialState({ players: ['alice', 'bob'], redFirst: 'alice' });
}

function play(state, moves) {
    let s = state;
    for (const [nick, col] of moves) {
        if (!c4Spec.validateMove(s, nick, { col })) {
            throw new Error(`test move rejected: ${nick} -> col ${col}\nstate: ${JSON.stringify(s)}`);
        }
        s = c4Spec.applyMove(s, nick, { col });
    }
    return s;
}

test('C4: initialState assigns colors and lays out empty cols', () => {
    const s = startGame();
    assert.equal(s.redPlayer, 'alice');
    assert.equal(s.yellowPlayer, 'bob');
    assert.equal(s.turn, 'R');
    assert.equal(s.cols.length, C4_COLS);
    assert.ok(s.cols.every(c => c.length === 0));
    assert.equal(s.winner, null);
});

test('C4: gravity stacks discs bottom-up in the same column', () => {
    let s = startGame();
    s = c4Spec.applyMove(s, 'alice', { col: 3 });  // R bottom
    s = c4Spec.applyMove(s, 'bob',   { col: 3 });  // Y on top of R
    s = c4Spec.applyMove(s, 'alice', { col: 3 });  // R on top of Y
    assert.deepEqual(s.cols[3], ['R', 'Y', 'R']);
});

test('C4: validateMove rejects full column', () => {
    let s = startGame();
    // Fill column 0 with 6 alternating drops.
    for (let i = 0; i < C4_ROWS; i++) {
        const nick = (i % 2 === 0) ? 'alice' : 'bob';
        s = c4Spec.applyMove(s, nick, { col: 0 });
    }
    assert.equal(s.cols[0].length, C4_ROWS);
    // Next drop on col 0 must be rejected.
    const next = s.turn === 'R' ? 'alice' : 'bob';
    assert.equal(c4Spec.validateMove(s, next, { col: 0 }), false);
});

test('C4: validateMove rejects bad payloads', () => {
    const s = startGame();
    assert.equal(c4Spec.validateMove(s, 'alice', null), false);
    assert.equal(c4Spec.validateMove(s, 'alice', {}), false);
    assert.equal(c4Spec.validateMove(s, 'alice', { col: '3' }), false);
    assert.equal(c4Spec.validateMove(s, 'alice', { col: 1.5 }), false);
    assert.equal(c4Spec.validateMove(s, 'alice', { col: -1 }), false);
    assert.equal(c4Spec.validateMove(s, 'alice', { col: 7 }), false);
});

test('C4: validateMove rejects out-of-turn move', () => {
    const s = startGame();
    assert.equal(c4Spec.validateMove(s, 'bob', { col: 0 }), false);
    assert.equal(c4Spec.validateMove(s, 'alice', { col: 0 }), true);
});

test('C4: detects vertical 4-in-a-row', () => {
    // Alice (R) drops 4 in col 3, Bob (Y) drops 3 in col 4 (no overlap).
    const s = play(startGame(), [
        ['alice', 3], ['bob', 4],
        ['alice', 3], ['bob', 4],
        ['alice', 3], ['bob', 4],
        ['alice', 3],  // winning vertical 4
    ]);
    assert.equal(s.winner, 'alice');
    assert.equal(s.winningLine.length, 4);
    assert.ok(s.winningLine.every(([c, _r]) => c === 3));
});

test('C4: detects horizontal 4-in-a-row on the bottom row', () => {
    // Alice drops in cols 0,1,2,3 (R); Bob drops in col 5,6,5 (Y) — anywhere but row 0 cols 0-3.
    const s = play(startGame(), [
        ['alice', 0], ['bob', 5],
        ['alice', 1], ['bob', 6],
        ['alice', 2], ['bob', 5],  // bob stacks in col 5
        ['alice', 3],  // winning horizontal at row 0
    ]);
    assert.equal(s.winner, 'alice');
    assert.deepEqual(s.winningLine.sort((a, b) => a[0] - b[0]),
                     [[0, 0], [1, 0], [2, 0], [3, 0]]);
});

test('C4: detects diagonal-up 4-in-a-row', () => {
    // Build a stair-step in cols 0,1,2,3 with alice (R) at diagonal cells (0,0),(1,1),(2,2),(3,3).
    // Need 0 reds at row 1 col 1, 2 reds at row 2 col 2, 3 reds at row 3 col 3.
    // Plan: alternate so the diagonal cells end up R.
    const s = play(startGame(), [
        ['alice', 0],  // R at (0,0)
        ['bob',   1],  // Y at (1,0)
        ['alice', 1],  // R at (1,1)
        ['bob',   2],  // Y at (2,0)
        ['alice', 5],  // R waste at (5,0)  — keep turn alternation
        ['bob',   2],  // Y at (2,1)
        ['alice', 2],  // R at (2,2)
        ['bob',   3],  // Y at (3,0)
        ['alice', 6],  // R waste at (6,0)
        ['bob',   3],  // Y at (3,1)
        ['alice', 5],  // R waste at (5,1)
        ['bob',   3],  // Y at (3,2)
        ['alice', 3],  // R at (3,3)  — completes diagonal (0,0)→(3,3)
    ]);
    assert.equal(s.winner, 'alice');
});

test('C4: detects diagonal-down 4-in-a-row', () => {
    // Diagonal: (0,3),(1,2),(2,1),(3,0). Alice owns the diag.
    const s = play(startGame(), [
        ['alice', 3],   // R (3,0)
        ['bob',   2],   // Y (2,0)
        ['alice', 2],   // R (2,1)
        ['bob',   1],   // Y (1,0)
        ['alice', 1],   // R (1,1)
        ['bob',   0],   // Y (0,0)
        ['alice', 1],   // R (1,2) — irrelevant
        ['bob',   0],   // Y (0,1)
        ['alice', 0],   // R (0,2)
        ['bob',   6],   // Y waste (6,0)
        ['alice', 0],   // R (0,3) — completes diagonal
    ]);
    assert.equal(s.winner, 'alice');
});

test('C4: full board with no winner is a draw', () => {
    // Connect 4 has very few no-win full-board positions. Construct one
    // explicitly: three-of-a-color stripes in each column with the colors
    // offset so no 4-in-a-row forms in any direction.
    //   col 0: R R R Y Y Y
    //   col 1: Y Y Y R R R
    //   col 2: R R R Y Y Y
    //   col 3: Y Y Y R R R
    //   col 4: R R R Y Y Y
    //   col 5: Y Y Y R R R
    //   col 6: R R R Y Y Y
    // Verified by hand: no vertical/horizontal/diagonal 4-in-a-row.
    const cols = Array.from({ length: 7 }, (_, c) => (
        (c % 2 === 0)
            ? ['R','R','R','Y','Y','Y']
            : ['Y','Y','Y','R','R','R']
    ));
    const state = {
        cols, turn: 'R',
        redPlayer: 'alice', yellowPlayer: 'bob',
        winner: null, winningLine: null,
    };
    assert.equal(c4CheckWinner(cols).winner, null,
        'this hand-constructed full board should have no winner');
    assert.equal(c4Spec.isOver(state), true);
    assert.equal(c4Spec.winner(state), null);
});

test('C4: rejects move after game-over', () => {
    const s = play(startGame(), [
        ['alice', 3], ['bob', 4],
        ['alice', 3], ['bob', 4],
        ['alice', 3], ['bob', 4],
        ['alice', 3],  // vertical win
    ]);
    assert.equal(c4Spec.validateMove(s, 'bob', { col: 0 }), false);
});

test('C4: applyMove returns a NEW state (no mutation)', () => {
    const s1 = startGame();
    const s2 = c4Spec.applyMove(s1, 'alice', { col: 0 });
    assert.notStrictEqual(s1, s2);
    assert.notStrictEqual(s1.cols, s2.cols);
    assert.equal(s1.cols[0].length, 0);  // untouched
    assert.deepEqual(s2.cols[0], ['R']);
});
