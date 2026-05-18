/**
 * Pure helpers shared by server.js (production wiring) and test/ (unit tests).
 *
 * Anything in here MUST be free of side effects — no listening on ports, no
 * mutable module-level state, no `setInterval`. That's what makes it cheap
 * for the test runner to require this file without booting a server.
 *
 * server.js wires these into the live socket + HTTP handlers; the tests
 * exercise them in isolation.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// WS auth tokens — mirrors mint_ws_token() in backend.php / index.php.
// Token format: base64url(payload).hex(hmac(payload, secret))
// payload is JSON: { nickname, exp }
//
// Returns a closure so the caller binds the secret once at startup instead
// of plumbing it through every call.
// ---------------------------------------------------------------------------

function makeVerifyToken(secret) {
  return function verifyToken(token, now = Math.floor(Date.now() / 1000)) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const dot = token.lastIndexOf('.');
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    let payload;
    try {
      const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload.nickname !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp < now) return null;

    if (secret) {
      const expected = crypto.createHmac('sha256', secret).update(b64).digest('hex');
      const a = Buffer.from(sig, 'hex');
      const b = Buffer.from(expected, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    } else {
      if (sig !== 'dev') return null;
    }
    return payload;
  };
}

// Mint a token. Used by tests to round-trip with verifyToken; production
// minting happens in PHP, but having the JS minter handy makes tests trivial.
function mintToken(secret, nickname, ttlSec = 86400, now = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify({ nickname, exp: now + ttlSec });
  const b64 = Buffer.from(payload, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = secret
    ? crypto.createHmac('sha256', secret).update(b64).digest('hex')
    : 'dev';
  return `${b64}.${sig}`;
}

// ---------------------------------------------------------------------------
// Routing / identity helpers
// ---------------------------------------------------------------------------

// DM history is keyed by the sorted pair so {alice, bob} and {bob, alice}
// land in the same bucket. Centralized so callers can't accidentally diverge.
const dmKey = (a, b) => [a, b].sort().join('|');

// Coerce roomId / gameId to string. lastInsertId() in PHP returns a string;
// SELECT id returns an int. Without normalization those become separate keys.
const idKey = (r) => (r == null ? null : String(r));

// ---------------------------------------------------------------------------
// Game framework — Phase 1 sets up the registry shape; Phase 2 fills it in.
// ---------------------------------------------------------------------------

// Mint a short, URL-safe game ID. Length is a balance — long enough to not
// collide in a 30-min window, short enough that DM-stored receipts stay
// human-readable.
function newGameId() {
  return crypto.randomBytes(9).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The registry: { [gameType]: GameSpec }
// A GameSpec must implement:
//   initialState({ players }) -> object        // server-authoritative state
//   validateMove(state, nick, move) -> bool    // is this move legal *right now*?
//   applyMove(state, nick, move)    -> state'  // returns NEW state (immutable style)
//   publicState(state, viewer)      -> object  // strip hidden info for the viewer
//   isOver(state)                   -> bool
//   winner(state)                   -> string|null  // null = draw or in-progress
//
// Phase 1 leaves it empty. Phase 2 registers 'ttt' and 'rps'.
const GAME_REGISTRY = Object.create(null);

function registerGame(type, spec) {
  if (typeof type !== 'string' || !type) {
    throw new TypeError('registerGame: type must be a non-empty string');
  }
  for (const fn of ['initialState','validateMove','applyMove','publicState','isOver','winner']) {
    if (typeof spec[fn] !== 'function') {
      throw new TypeError(`registerGame(${type}): missing required function ${fn}()`);
    }
  }
  GAME_REGISTRY[type] = spec;
}

function getGameSpec(type) {
  return GAME_REGISTRY[type] || null;
}

// Validates the shape of a game_invite message before we touch any state.
// Returns { ok: true, normalized } or { ok: false, error }.
function validateInvite(data, sender) {
  if (!sender || typeof sender !== 'string') {
    return { ok: false, error: 'sender unknown — identify first' };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'invite payload missing' };
  }
  const to = typeof data.to === 'string' ? data.to.trim() : '';
  const gameType = typeof data.gameType === 'string' ? data.gameType.trim() : '';
  if (!to) return { ok: false, error: 'to is required' };
  if (!gameType) return { ok: false, error: 'gameType is required' };
  if (to === sender) return { ok: false, error: "can't challenge yourself" };
  // Phase 1: we accept any gameType so the "Coming Soon" UI works end-to-end.
  // Phase 2 will gate on GAME_REGISTRY[gameType].
  return {
    ok: true,
    normalized: {
      to,
      gameType,
      gameId: typeof data.gameId === 'string' && data.gameId ? data.gameId : newGameId(),
    },
  };
}

// In-memory game lifecycle helpers. Real storage is a Map kept on the
// server module — these just compute on a passed-in entry so tests can
// drive them without touching server-global state.

function makeGameEntry({ gameId, gameType, players, status = 'pending' }) {
  return {
    gameId,
    gameType,
    players: Array.from(new Set(players)),  // dedupe
    status,                                  // 'pending' | 'active' | 'over' | 'declined'
    state: null,                             // populated on accept
    winner: null,                            // populated on game-over
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

// Returns the IDs of games to garbage-collect. Pure — takes a snapshot of
// the games map and a wall-clock `now`. Server.js calls this from a periodic
// timer and removes whatever IDs come back.
function findStaleGames(games, now = Date.now(), ttlMs = 30 * 60 * 1000) {
  const stale = [];
  for (const [id, entry] of games) {
    if (now - entry.lastActivityAt > ttlMs) stale.push(id);
  }
  return stale;
}

// ===========================================================================
// Tic Tac Toe spec — turn-based, server-authoritative.
// ===========================================================================
//
// State shape:
//   {
//     board: Array(9) of 'X'|'O'|null  (row-major, top-left = 0)
//     turn:  'X' | 'O'                  (whose move it is)
//     xPlayer: string  (nickname controlling X)
//     oPlayer: string  (nickname controlling O)
//     winner: string|null              (nickname; set on three-in-a-row)
//     winningLine: number[]|null       (cell indices, for client to stroke)
//   }
// Move shape: { cell: 0..8 }

const TTT_WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],  // rows
  [0,3,6],[1,4,7],[2,5,8],  // cols
  [0,4,8],[2,4,6],          // diagonals
];

function tttCheckWinner(board) {
  for (const line of TTT_WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line };
    }
  }
  return { winner: null, line: null };
}

function tttIsDraw(state) {
  return state.winner === null && state.board.every(c => c !== null);
}

// Pure factory so the test suite can construct deterministic starts.
function makeTttInitialState({ players, xFirst = null }) {
  const [a, b] = players;
  // xFirst lets tests pin the assignment; production randomizes.
  const xPlayer = xFirst != null ? xFirst : (Math.random() < 0.5 ? a : b);
  const oPlayer = xPlayer === a ? b : a;
  return {
    board: Array(9).fill(null),
    turn: 'X',
    xPlayer,
    oPlayer,
    winner: null,
    winningLine: null,
  };
}

const tttSpec = {
  initialState({ players }) { return makeTttInitialState({ players }); },

  validateMove(state, nick, move) {
    if (!state || state.winner) return false;
    if (tttIsDraw(state)) return false;
    if (!move || typeof move !== 'object' || typeof move.cell !== 'number') return false;
    const cell = move.cell;
    if (cell < 0 || cell > 8 || !Number.isInteger(cell)) return false;
    if (state.board[cell] !== null) return false;
    const expected = state.turn === 'X' ? state.xPlayer : state.oPlayer;
    if (nick !== expected) return false;
    return true;
  },

  applyMove(state, nick, move) {
    const board = state.board.slice();
    board[move.cell] = state.turn;
    const { winner: winnerSymbol, line } = tttCheckWinner(board);
    return {
      ...state,
      board,
      turn: state.turn === 'X' ? 'O' : 'X',
      winner: winnerSymbol
        ? (winnerSymbol === 'X' ? state.xPlayer : state.oPlayer)
        : null,
      winningLine: line,
    };
  },

  // TTT has no hidden information — same view for everyone.
  publicState(state, _viewer) { return state; },

  isOver(state) {
    return Boolean(state.winner) || tttIsDraw(state);
  },

  winner(state) {
    // Returns the winning nickname, or null for draw / in-progress.
    return state.winner;
  },
};

// ===========================================================================
// Rock Paper Scissors spec — best-of-3, simultaneous reveal.
// ===========================================================================
//
// State shape:
//   {
//     round: number                    (1-indexed)
//     maxRounds: number                (typically 3)
//     winsNeeded: number               (typically 2 — best-of-3)
//     scores: { [nick]: number }
//     picks:  { [nick]: 'rock'|'paper'|'scissors'|null }
//     history: Array<{ round, picks, winner }>   // resolved rounds
//   }
// Move shape: { pick: 'rock' | 'paper' | 'scissors' }
//
// Reveal flow: while a round is in progress, picks[nick] is null until that
// nickname submits a move. publicState() hides the opponent's submitted
// pick (replaces with '__hidden__') so neither player can scrape the WS
// payload to peek. Once both have picked, applyMove resolves: picks reset
// to null, history gains a row with both picks + the round winner.

const RPS_OPTIONS = ['rock', 'paper', 'scissors'];

const RPS_BEATS = Object.freeze({
  rock:     'scissors',
  paper:    'rock',
  scissors: 'paper',
});

function makeRpsInitialState({ players, maxRounds = 3 }) {
  const [a, b] = players;
  return {
    round: 1,
    maxRounds,
    winsNeeded: Math.floor(maxRounds / 2) + 1,
    scores: { [a]: 0, [b]: 0 },
    picks:  { [a]: null, [b]: null },
    history: [],
  };
}

function rpsRoundWinner(pickA, pickB, a, b) {
  if (pickA === pickB) return null;
  return RPS_BEATS[pickA] === pickB ? a : b;
}

const rpsSpec = {
  initialState({ players }) { return makeRpsInitialState({ players }); },

  validateMove(state, nick, move) {
    if (!state) return false;
    if (rpsSpec.isOver(state)) return false;
    if (!(nick in state.picks)) return false;     // not a player in this game
    if (state.picks[nick] !== null) return false;  // already picked this round
    if (!move || typeof move !== 'object') return false;
    if (!RPS_OPTIONS.includes(move.pick)) return false;
    return true;
  },

  applyMove(state, nick, move) {
    const picks = { ...state.picks, [nick]: move.pick };
    const players = Object.keys(picks);
    const bothPicked = players.every(p => picks[p] !== null);

    // First half of the round — opponent hasn't picked yet. Hold state.
    if (!bothPicked) {
      return { ...state, picks };
    }

    // Resolve the round.
    const [a, b] = players;
    const winner = rpsRoundWinner(picks[a], picks[b], a, b);
    const scores = { ...state.scores };
    if (winner) scores[winner] = (scores[winner] || 0) + 1;
    const history = [...state.history, {
      round:  state.round,
      picks:  { [a]: picks[a], [b]: picks[b] },
      winner,
    }];

    return {
      ...state,
      round:   state.round + 1,
      scores,
      picks:   { [a]: null, [b]: null },
      history,
    };
  },

  publicState(state, viewer) {
    // Hide the opponent's *current-round* pick. Past picks (in history) are
    // visible — they're already revealed by the time they land in history.
    const picks = { ...state.picks };
    for (const player of Object.keys(picks)) {
      if (player !== viewer && picks[player] !== null) {
        picks[player] = '__hidden__';
      }
    }
    return { ...state, picks };
  },

  isOver(state) {
    const scores = Object.values(state.scores);
    if (scores.some(s => s >= state.winsNeeded)) return true;
    // Edge case: max rounds played and still tied (with even maxRounds).
    if (state.history.length >= state.maxRounds) return true;
    return false;
  },

  winner(state) {
    const players = Object.keys(state.scores);
    const [a, b] = players;
    if (state.scores[a] === state.scores[b]) return null;
    return state.scores[a] > state.scores[b] ? a : b;
  },
};

// ===========================================================================
// Connect Four spec (Phase 4.1) — turn-based, gravity, 4-in-a-row in any direction.
// ===========================================================================
//
// State shape:
//   {
//     cols: Array(7) of arrays of 'R'|'Y'  (bottom-up: cols[c][0] is bottom)
//     turn: 'R' | 'Y'
//     redPlayer, yellowPlayer: nicknames
//     winner: nickname | null
//     winningLine: [[c,r], ...] | null    // cell coords of the 4-in-a-row
//   }
// Move shape: { col: 0..6 }

const C4_COLS = 7;
const C4_ROWS = 6;
const C4_DIRS = [
  [0, 1],   // vertical
  [1, 0],   // horizontal
  [1, 1],   // diagonal up-right
  [1, -1],  // diagonal down-right
];

function c4CellAt(cols, c, r) {
  if (c < 0 || c >= C4_COLS || r < 0 || r >= C4_ROWS) return undefined;
  return cols[c][r];
}

function c4CheckWinner(cols) {
  for (let c = 0; c < C4_COLS; c++) {
    for (let r = 0; r < C4_ROWS; r++) {
      const v = c4CellAt(cols, c, r);
      if (!v) continue;
      for (const [dc, dr] of C4_DIRS) {
        const line = [[c, r]];
        for (let k = 1; k < 4; k++) {
          if (c4CellAt(cols, c + dc * k, r + dr * k) !== v) break;
          line.push([c + dc * k, r + dr * k]);
        }
        if (line.length === 4) return { winner: v, line };
      }
    }
  }
  return { winner: null, line: null };
}

function makeC4InitialState({ players, redFirst = null }) {
  const [a, b] = players;
  const redPlayer    = redFirst != null ? redFirst : (Math.random() < 0.5 ? a : b);
  const yellowPlayer = redPlayer === a ? b : a;
  return {
    cols: Array.from({ length: C4_COLS }, () => []),
    turn: 'R',
    redPlayer,
    yellowPlayer,
    winner: null,
    winningLine: null,
  };
}

const c4Spec = {
  initialState({ players }) { return makeC4InitialState({ players }); },

  validateMove(state, nick, move) {
    if (!state || state.winner) return false;
    if (!move || typeof move !== 'object' || typeof move.col !== 'number') return false;
    const col = move.col;
    if (col < 0 || col >= C4_COLS || !Number.isInteger(col)) return false;
    if (state.cols[col].length >= C4_ROWS) return false; // column full
    const expected = state.turn === 'R' ? state.redPlayer : state.yellowPlayer;
    if (nick !== expected) return false;
    return true;
  },

  applyMove(state, nick, move) {
    const cols = state.cols.map(c => c.slice());
    cols[move.col].push(state.turn);
    const { winner: winSym, line } = c4CheckWinner(cols);
    return {
      ...state,
      cols,
      turn: state.turn === 'R' ? 'Y' : 'R',
      winner: winSym ? (winSym === 'R' ? state.redPlayer : state.yellowPlayer) : null,
      winningLine: line,
    };
  },

  publicState(state, _viewer) { return state; },

  isOver(state) {
    if (state.winner) return true;
    return state.cols.every(c => c.length >= C4_ROWS);
  },

  winner(state) { return state.winner; },
};

// ===========================================================================
// Hangman spec (Phase 4.1) — picker submits a word, guesser guesses letters.
// ===========================================================================
//
// State shape:
//   {
//     phase: 'awaiting_word' | 'guessing' | 'over'
//     picker:  nickname  (chooses the word)
//     guesser: nickname  (guesses letters)
//     word: string                    (full lowercase word — picker-only view)
//     mask: string                    (underscores + revealed chars + spaces)
//     wrong: string[]                 (letters guessed wrong, in order)
//     correct: string[]               (letters guessed right, in order)
//     maxWrong: 6                     (parts of the hangman)
//     winner: nickname | null
//   }
// Move shapes:
//   - picker, phase=awaiting_word:  { word: 'pizza party' }
//   - guesser, phase=guessing:      { letter: 'e' }

const HANGMAN_MAX_WRONG = 6;
const HANGMAN_WORD_REGEX = /^[a-z][a-z\s'\-]{1,30}$/;

function hangmanMaskWord(word, correctSet) {
  return word.split('').map(c => {
    if (!/[a-z]/.test(c)) return c;
    return correctSet.has(c) ? c : '_';
  }).join('');
}

function makeHangmanInitialState({ players }) {
  const [picker, guesser] = players;
  return {
    phase: 'awaiting_word',
    picker,
    guesser,
    word: '',
    mask: '',
    wrong: [],
    correct: [],
    maxWrong: HANGMAN_MAX_WRONG,
    winner: null,
  };
}

const hangmanSpec = {
  initialState({ players }) { return makeHangmanInitialState({ players }); },

  validateMove(state, nick, move) {
    if (!state || state.phase === 'over') return false;
    if (!move || typeof move !== 'object') return false;

    if (state.phase === 'awaiting_word') {
      // Only the picker submits the word.
      if (nick !== state.picker) return false;
      if (typeof move.word !== 'string') return false;
      const w = move.word.trim().toLowerCase();
      return HANGMAN_WORD_REGEX.test(w);
    }

    // phase === 'guessing' — only the guesser submits letters.
    if (nick !== state.guesser) return false;
    if (typeof move.letter !== 'string') return false;
    const l = move.letter.trim().toLowerCase();
    if (!/^[a-z]$/.test(l)) return false;
    // Letter must not already have been guessed (either bucket).
    if (state.correct.includes(l) || state.wrong.includes(l)) return false;
    return true;
  },

  applyMove(state, nick, move) {
    if (state.phase === 'awaiting_word') {
      const word = move.word.trim().toLowerCase();
      const correctSet = new Set();
      return {
        ...state,
        word,
        mask: hangmanMaskWord(word, correctSet),
        phase: 'guessing',
      };
    }
    const letter = move.letter.trim().toLowerCase();
    const hit = state.word.includes(letter);
    const correct = hit ? [...state.correct, letter] : state.correct;
    const wrong   = hit ? state.wrong : [...state.wrong, letter];
    const mask    = hit ? hangmanMaskWord(state.word, new Set(correct)) : state.mask;
    const won  = hit && !mask.includes('_');
    const lost = !hit && wrong.length >= state.maxWrong;
    return {
      ...state,
      correct, wrong, mask,
      phase: (won || lost) ? 'over' : 'guessing',
      winner: won ? state.guesser : (lost ? state.picker : null),
    };
  },

  // Picker can see the word at all times. Guesser sees only mask + guesses
  // until the game ends, then the word is revealed to everyone.
  publicState(state, viewer) {
    if (state.phase === 'over' || viewer === state.picker) {
      return state;
    }
    // viewer is the guesser, game still going — strip the answer.
    const out = { ...state };
    out.word = '';
    return out;
  },

  isOver(state) { return state.phase === 'over'; },
  winner(state) { return state.winner; },
};

// Register all GameSpecs at module load. Calling registerGame() validates
// the shape so missing methods would throw immediately — fail fast.
registerGame('ttt',     tttSpec);
registerGame('rps',     rpsSpec);
registerGame('c4',      c4Spec);
registerGame('hangman', hangmanSpec);

module.exports = {
  // auth
  makeVerifyToken,
  mintToken,
  // routing
  dmKey,
  idKey,
  // games
  newGameId,
  registerGame,
  getGameSpec,
  GAME_REGISTRY,
  validateInvite,
  makeGameEntry,
  findStaleGames,
  // game specs (exported for testing)
  tttSpec,
  rpsSpec,
  c4Spec,
  hangmanSpec,
  TTT_WIN_LINES,
  RPS_OPTIONS,
  RPS_BEATS,
  C4_COLS,
  C4_ROWS,
  HANGMAN_MAX_WRONG,
  makeTttInitialState,
  makeRpsInitialState,
  makeC4InitialState,
  makeHangmanInitialState,
  tttCheckWinner,
  rpsRoundWinner,
  c4CheckWinner,
  hangmanMaskWord,
};
