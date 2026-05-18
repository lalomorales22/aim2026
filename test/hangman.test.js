/**
 * Tests for the Hangman GameSpec (Phase 4.1).
 *
 * Two-phase: picker submits a word, then guesser guesses letters.
 *
 * Covers:
 *   - Word validation (format + length range)
 *   - publicState hides word from guesser until game ends
 *   - Letter guess flow: correct reveals, wrong increments
 *   - Win on full reveal, lose on maxWrong
 *   - Reject double-guess of the same letter
 *   - Reject moves from the wrong player in each phase
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    hangmanSpec, makeHangmanInitialState, hangmanMaskWord, HANGMAN_MAX_WRONG,
} = require('../lib/core');

function startGame() {
    return makeHangmanInitialState({ players: ['picky', 'guessy'] });
}

function submitWord(s, word) {
    return hangmanSpec.applyMove(s, 'picky', { word });
}

function guess(s, letter) {
    return hangmanSpec.applyMove(s, 'guessy', { letter });
}

test('Hangman: initialState has the right roles + phase', () => {
    const s = startGame();
    assert.equal(s.phase, 'awaiting_word');
    assert.equal(s.picker, 'picky');
    assert.equal(s.guesser, 'guessy');
    assert.equal(s.maxWrong, HANGMAN_MAX_WRONG);
    assert.equal(s.word, '');
});

test('Hangman: only the picker can submit the word', () => {
    const s = startGame();
    assert.equal(hangmanSpec.validateMove(s, 'guessy', { word: 'pizza' }), false);
    assert.equal(hangmanSpec.validateMove(s, 'picky', { word: 'pizza' }),  true);
});

test('Hangman: word format is enforced', () => {
    const s = startGame();
    // Must start with a letter, only lowercase letters / space / apostrophe / dash.
    assert.equal(hangmanSpec.validateMove(s, 'picky', { word: '' }),          false);
    assert.equal(hangmanSpec.validateMove(s, 'picky', { word: 'a' }),         false); // too short
    assert.equal(hangmanSpec.validateMove(s, 'picky', { word: '1pizza' }),    false); // starts with digit
    assert.equal(hangmanSpec.validateMove(s, 'picky', { word: 'pizza!!' }),   false); // punctuation
    assert.equal(hangmanSpec.validateMove(s, 'picky', { word: 'pizza' }),     true);
    assert.equal(hangmanSpec.validateMove(s, 'picky', { word: "rock 'n roll" }), true);
    assert.equal(hangmanSpec.validateMove(s, 'picky', { word: 'rock-paper-scissors' }), true);
});

test('Hangman: submitting a word advances phase + masks letters', () => {
    let s = startGame();
    s = submitWord(s, 'pizza');
    assert.equal(s.phase, 'guessing');
    assert.equal(s.word, 'pizza');
    assert.equal(s.mask, '_____');
});

test('Hangman: mask preserves spaces and punctuation', () => {
    let s = startGame();
    s = submitWord(s, "rock 'n roll");
    assert.equal(s.mask, "____ '_ ____");
});

test('Hangman: correct letter reveals all occurrences', () => {
    let s = startGame();
    s = submitWord(s, 'banana');
    s = guess(s, 'a');
    assert.equal(s.mask, '_a_a_a');
    assert.deepEqual(s.correct, ['a']);
    assert.deepEqual(s.wrong, []);
});

test('Hangman: wrong letter increments wrong[]', () => {
    let s = startGame();
    s = submitWord(s, 'banana');
    s = guess(s, 'z');
    assert.deepEqual(s.wrong, ['z']);
    assert.equal(s.mask, '______');
});

test('Hangman: full reveal → guesser wins', () => {
    let s = startGame();
    s = submitWord(s, 'cat');
    s = guess(s, 'c');
    s = guess(s, 'a');
    s = guess(s, 't');
    assert.equal(s.phase, 'over');
    assert.equal(s.winner, 'guessy');
});

test('Hangman: maxWrong wrong guesses → picker wins', () => {
    let s = startGame();
    s = submitWord(s, 'zebra');
    // 6 wrong guesses (none in 'zebra').
    for (const l of ['q','w','t','y','u','i']) s = guess(s, l);
    assert.equal(s.wrong.length, HANGMAN_MAX_WRONG);
    assert.equal(s.phase, 'over');
    assert.equal(s.winner, 'picky');
});

test('Hangman: rejects double-guessing a letter', () => {
    let s = startGame();
    s = submitWord(s, 'pizza');
    s = guess(s, 'p');
    assert.equal(hangmanSpec.validateMove(s, 'guessy', { letter: 'p' }), false);
    s = guess(s, 'x');  // wrong
    assert.equal(hangmanSpec.validateMove(s, 'guessy', { letter: 'x' }), false);
});

test('Hangman: rejects multi-char guesses + bad payloads', () => {
    let s = startGame();
    s = submitWord(s, 'pizza');
    assert.equal(hangmanSpec.validateMove(s, 'guessy', { letter: 'ab' }), false);
    assert.equal(hangmanSpec.validateMove(s, 'guessy', { letter: '1' }), false);
    assert.equal(hangmanSpec.validateMove(s, 'guessy', { letter: '' }), false);
    assert.equal(hangmanSpec.validateMove(s, 'guessy', null), false);
});

test('Hangman: only guesser can guess letters', () => {
    let s = startGame();
    s = submitWord(s, 'pizza');
    assert.equal(hangmanSpec.validateMove(s, 'picky', { letter: 'p' }), false);
});

test('Hangman: rejects moves after game-over', () => {
    let s = startGame();
    s = submitWord(s, 'cat');
    s = guess(s, 'c'); s = guess(s, 'a'); s = guess(s, 't');
    assert.equal(s.phase, 'over');
    assert.equal(hangmanSpec.validateMove(s, 'guessy', { letter: 'z' }), false);
});

test('Hangman: publicState hides the word from the guesser', () => {
    let s = startGame();
    s = submitWord(s, 'secret');
    const guesserView = hangmanSpec.publicState(s, 'guessy');
    assert.equal(guesserView.word, '');
    assert.equal(guesserView.mask, '______');
    // Picker still sees it.
    const pickerView = hangmanSpec.publicState(s, 'picky');
    assert.equal(pickerView.word, 'secret');
});

test('Hangman: publicState reveals word to both once game ends', () => {
    let s = startGame();
    s = submitWord(s, 'cat');
    s = guess(s, 'c'); s = guess(s, 'a'); s = guess(s, 't');
    const guesserView = hangmanSpec.publicState(s, 'guessy');
    assert.equal(guesserView.word, 'cat');
});

test('Hangman: hangmanMaskWord matches the word format with spaces', () => {
    assert.equal(hangmanMaskWord('hi there', new Set()),       '__ _____');
    // Both 'h's reveal — the one in "hi" and the one in "there".
    assert.equal(hangmanMaskWord('hi there', new Set(['h'])),  'h_ _h___');
    assert.equal(hangmanMaskWord('abc', new Set(['b'])),       '_b_');
    assert.equal(hangmanMaskWord('abc', new Set(['a','b','c'])), 'abc');
});

test('Hangman: applyMove returns a NEW state (no mutation)', () => {
    const s1 = submitWord(startGame(), 'foo');
    const s2 = hangmanSpec.applyMove(s1, 'guessy', { letter: 'o' });
    assert.notStrictEqual(s1, s2);
    assert.deepEqual(s1.correct, []);
    assert.deepEqual(s2.correct, ['o']);
});
