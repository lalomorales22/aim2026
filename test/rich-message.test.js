/**
 * Tests for the rich-message rendering pipeline introduced in Phase 3.3 +
 * 3.4. The functions live in script.js (client side, no module export) so
 * we eval the relevant slice in a sandbox that mocks the browser globals
 * the renderer touches.
 *
 * What we're guarding against:
 *   - HTML injection through chat content (the worst-case bug)
 *   - smiley substitution mishandling escape boundaries
 *   - style whitelist letting through dangerous CSS
 *   - JSON-wire-format parsing accepting non-objects
 *   - encodeRichMessage stripping no-op styles for backward-compat storage
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
// Non-strict assert — the renderer runs in a vm sandbox whose Object.prototype
// is not === to ours, so strict deepEqual would false-fail on prototype mismatch
// even though the values are structurally identical.
const assert = require('node:assert');

// Load script.js, then evaluate just the slice we need in a sandbox with
// stub browser globals. The script.js boots a lot of UI on load, but pulling
// only the relevant declarations avoids that.
const scriptSource = fs.readFileSync(
    path.join(__dirname, '..', 'script.js'), 'utf8'
);

// Extract the block between the AIM_SMILEYS declaration and the end of
// encodeRichMessage. That gives us the renderer surface without the DOM
// wiring that follows.
function sliceBetween(src, startMarker, endMarker) {
    const a = src.indexOf(startMarker);
    const b = src.indexOf(endMarker, a);
    if (a < 0 || b < 0) throw new Error('marker not found');
    return src.substring(a, b);
}

const slice = [
    // escapeHtml is the renderer's only dependency in the slice we test.
    `function escapeHtml(unsafe) {
        if (unsafe == null) return '';
        return String(unsafe)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }`,
    sliceBetween(
        scriptSource,
        'const AIM_SMILEYS = {',
        '// Wires a smiley-picker button'
    ),
].join('\n');

// Stub browser globals so the slice doesn't crash if it accidentally
// touches them — `window` and `document` aren't needed for the renderer
// but are referenced as fallbacks elsewhere.
const sandbox = {
    module: { exports: {} },
    console,
};
vm.createContext(sandbox);
vm.runInContext(slice + `
    module.exports = { parseRichMessage, renderRichMessage, encodeRichMessage,
                       styleToCss, AIM_SMILEYS, AIM_ALLOWED_FONTS };
`, sandbox);

const {
    parseRichMessage, renderRichMessage, encodeRichMessage, styleToCss,
    AIM_SMILEYS, AIM_ALLOWED_FONTS,
} = sandbox.module.exports;

// ---------------------------------------------------------------------------
// parseRichMessage
// ---------------------------------------------------------------------------

test('parseRichMessage: plain string passes through', () => {
    assert.deepEqual(parseRichMessage('hello'),  { text: 'hello', style: null });
});

test('parseRichMessage: empty / null safe', () => {
    assert.deepEqual(parseRichMessage(''),       { text: '', style: null });
    assert.deepEqual(parseRichMessage(null),     { text: '', style: null });
});

test('parseRichMessage: JSON wire format extracts text + style', () => {
    const wire = '{"text":"hi","style":{"bold":true,"color":"#ff0000"}}';
    assert.deepEqual(parseRichMessage(wire), {
        text: 'hi', style: { bold: true, color: '#ff0000' },
    });
});

test('parseRichMessage: malformed JSON falls back to plain text', () => {
    // Looks like JSON but isn't — we should NOT throw, just treat as plain.
    assert.deepEqual(parseRichMessage('{not json'), { text: '{not json', style: null });
});

test('parseRichMessage: JSON without a text field falls back to plain', () => {
    // Old code never emits this, but a bad client could — handle gracefully.
    assert.deepEqual(parseRichMessage('{"foo":1}'), { text: '{"foo":1}', style: null });
});

// ---------------------------------------------------------------------------
// renderRichMessage — security + correctness
// ---------------------------------------------------------------------------

test('renderRichMessage: escapes HTML control chars', () => {
    const out = renderRichMessage('<script>alert(1)</script>');
    assert.equal(
        out,
        '&lt;script&gt;alert(1)&lt;/script&gt;',
        'must escape — no raw <script> tag should survive',
    );
});

test('renderRichMessage: escapes a malicious onerror attempt', () => {
    const out = renderRichMessage('"><img src=x onerror=alert(1)>');
    // The dangerous pattern is `<img …onerror=…>` as a real tag. After
    // escaping, the word "onerror" appears in the output as literal text,
    // which is fine — what matters is that no real <img tag exists.
    assert.ok(!/<img\b/i.test(out),    'must not emit a raw <img> tag');
    assert.ok(!/<script\b/i.test(out), 'must not emit a raw <script> tag');
    // Every `<` we DO emit must be the start of one of our own structural
    // spans (start tag <span ... or close tag </span>).
    const tagOpens = out.match(/<[a-zA-Z/][^>]*>/g) || [];
    for (const t of tagOpens) {
        assert.ok(
            /^<span\b/.test(t) || t === '</span>',
            `unexpected tag in renderer output: ${t}`,
        );
    }
});

test('renderRichMessage: substitutes smileys cleanly', () => {
    const out = renderRichMessage('hello :)');
    assert.ok(out.includes('class="smiley"'));
    assert.ok(out.includes(AIM_SMILEYS[':)']));
});

test('renderRichMessage: substitutes longer smiley codes before shorter', () => {
    // ":-)" should match as a whole, NOT ":)" inside it.
    const out = renderRichMessage(':-)');
    // Only one smiley span; the entire ":-)" was the match.
    const spans = out.match(/class="smiley"/g) || [];
    assert.equal(spans.length, 1);
});

test('renderRichMessage: smiley codes around escaped chars do not interfere', () => {
    const out = renderRichMessage('<<3 lol');
    // The < gets escaped, but then the <3 SHOULD also be detected because we
    // run smiley substitution on the raw text before escaping. So expect a
    // heart span in there somewhere.
    assert.ok(out.includes('&lt;'), 'first < was escaped');
    assert.ok(out.includes('class="smiley"'));
});

test('renderRichMessage: applies whitelisted style', () => {
    const wire = JSON.stringify({ text: 'hi', style: { bold: true, color: '#ff0000' } });
    const out = renderRichMessage(wire);
    assert.ok(out.startsWith('<span style="'));
    assert.ok(out.includes('font-weight: bold'));
    assert.ok(out.includes('color: #ff0000'));
});

test('renderRichMessage: rejects non-hex colors', () => {
    const wire = JSON.stringify({ text: 'hi', style: { color: 'red; background:url(javascript:alert(1))' } });
    const out = renderRichMessage(wire);
    assert.ok(!out.includes('javascript'));
    assert.ok(!out.includes('background'));
});

test('renderRichMessage: rejects non-whitelisted font family', () => {
    const wire = JSON.stringify({ text: 'hi', style: { font: 'Wingdings; }html{display:none' } });
    const out = renderRichMessage(wire);
    // The font should not appear at all in the output style.
    assert.ok(!out.includes('Wingdings'));
    assert.ok(!out.includes('font-family'));
});

test('renderRichMessage: empty input yields empty output', () => {
    assert.equal(renderRichMessage(''), '');
    assert.equal(renderRichMessage(null), '');
});

// ---------------------------------------------------------------------------
// styleToCss
// ---------------------------------------------------------------------------

test('styleToCss: emits only whitelisted props', () => {
    const css = styleToCss({
        bold: true, italic: true, underline: true,
        color: '#abcdef',
        font: AIM_ALLOWED_FONTS[0],
        sneaky: 'expression(alert(1))',
    });
    assert.ok(css.includes('font-weight: bold'));
    assert.ok(css.includes('font-style: italic'));
    assert.ok(css.includes('text-decoration: underline'));
    assert.ok(css.includes('color: #abcdef'));
    assert.ok(css.includes('font-family:'));
    assert.ok(!css.includes('expression'));
    assert.ok(!css.includes('sneaky'));
});

test('styleToCss: ignores wrong types', () => {
    assert.equal(styleToCss(null), '');
    assert.equal(styleToCss('not an object'), '');
    assert.equal(styleToCss({ color: 12345 }), '');
});

// ---------------------------------------------------------------------------
// encodeRichMessage
// ---------------------------------------------------------------------------

test('encodeRichMessage: returns plain text when no style is active', () => {
    assert.equal(encodeRichMessage('hello', null), 'hello');
    assert.equal(encodeRichMessage('hello', {}), 'hello');
    assert.equal(encodeRichMessage('hello', {
        bold: false, italic: false, color: '#000000', font: 'MS Sans Serif',
    }), 'hello');
});

test('encodeRichMessage: JSON-wraps when any style is active', () => {
    const out = encodeRichMessage('hello', { bold: true });
    assert.deepEqual(JSON.parse(out), { text: 'hello', style: { bold: true } });
});

test('encodeRichMessage: strips off no-op fields to keep wire small', () => {
    const out = encodeRichMessage('hello', {
        bold: true, italic: false, color: '#000000', font: 'MS Sans Serif',
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.text, 'hello');
    assert.deepEqual(parsed.style, { bold: true });
});

test('encodeRichMessage + parseRichMessage round-trip preserves style', () => {
    const original = { bold: true, italic: true, color: '#ff00ff' };
    const wire = encodeRichMessage('round trip', original);
    const parsed = parseRichMessage(wire);
    assert.equal(parsed.text, 'round trip');
    assert.deepEqual(parsed.style, original);
});
