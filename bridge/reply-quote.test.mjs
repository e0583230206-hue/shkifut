// node --test bridge/reply-quote.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { stanzaId, snippetOf, quoteLine, createStore } = createRequire(import.meta.url)('./reply-quote.js');

test('the short id of a message: from the full id, and as it is when it is already short', () => {
  assert.equal(stanzaId('false_120363429217173923@g.us_3EB0F4A89CAAF35D4EB485_106953342742588@lid'), '3EB0F4A89CAAF35D4EB485');
  assert.equal(stanzaId('false_120363429217173923@g.us_ACAF1565F9B0BBAA2BE5AC2D49FC3F_120542803808311@lid'), 'ACAF1565F9B0BBAA2BE5AC2D49FC3F');
  assert.equal(stanzaId('ACACF7BB2B270C087309FBC016D3B009'), 'ACACF7BB2B270C087309FBC016D3B009');
  assert.equal(stanzaId(undefined), '');
  assert.equal(stanzaId(null), '');
});

test('the quote line uses the number of the site message', () => {
  assert.equal(quoteLine(1155, 'שלום עולם'), '[quote-embedded#](1155@שלום עולם)');
  assert.equal(quoteLine('12', 'x'), '[quote-embedded#](12@x)');
});

test('the short text is one safe line: no markup, brackets, HTML, "@" or line breaks', () => {
  const s = snippetOf('<script>alert(1)</script> [קישור](http://a.b) *מודגש* _נטוי_ ~מחוק~ `קוד`\nשורה שנייה @972500000000 "ציטוט" & עוד');
  assert.ok(!/[()<>\[\]@\n*_~`&"]/.test(s), s);
  assert.ok(s.includes('מודגש') && s.includes('שורה שנייה'), s);
});

test('embeds of the site and invisible marks do not stay in the short text', () => {
  assert.equal(snippetOf('[image-embedded#](/api/files/aabbccddeeff00112233445566778899aabbccdd.jpg) כיתוב'), 'כיתוב');
  assert.equal(snippetOf('‏‫שלום‬️'), 'שלום');
});

test('a long text is cut at 80 characters with "…", also with emoji (no half characters)', () => {
  const long = 'א'.repeat(200);
  const s = snippetOf(long);
  assert.equal([...s].length, 80);
  assert.ok(s.endsWith('…'));
  const e = snippetOf('😀'.repeat(200));
  assert.equal([...e].length, 80);
  assert.ok(!e.includes('�'));
});

test('a message with only media is quoted as "מדיה"; an empty text without media gives nothing', () => {
  assert.equal(snippetOf('', true), 'מדיה');
  assert.equal(snippetOf(undefined, true), 'מדיה');
  assert.equal(snippetOf('', false), '');
  assert.equal(snippetOf('[video-embedded#](/api/files/x)', true), 'מדיה');
});

test('the store remembers, survives a restart, and ignores bad values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'));
  const file = join(dir, 'sub', 'ids.json');
  try {
    const a = createStore(file);
    assert.equal(a.has('S1'), false);
    a.set('S1', 11); a.set('S2', 12);
    a.set('', 13); a.set('S3', 0); a.set('S4', -1); a.set('S5', 1.5); a.set('S6', NaN); a.set(undefined, 5);
    assert.equal(a.size(), 2);
    const b = createStore(file);                       // a new process reads the file
    assert.equal(b.get('S1'), 11); assert.equal(b.get('S2'), 12); assert.equal(b.has('S3'), false);
    assert.equal(existsSync(file + '.tmp'), false);    // written through a temporary file that is renamed
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the store keeps only the newest entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'));
  try {
    const s = createStore(join(dir, 'ids.json'), { max: 3 });
    for (let i = 1; i <= 5; i++) s.set('S' + i, i);
    assert.equal(s.size(), 3);
    assert.equal(s.has('S1'), false); assert.equal(s.has('S2'), false);
    assert.equal(s.get('S5'), 5);
    s.set('S3', 33);                                   // a repeated id moves to the newest place
    s.set('S6', 6);
    assert.equal(s.has('S4'), false); assert.equal(s.get('S3'), 33);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a broken or missing file means an empty store, and a disk that cannot be written does not throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'));
  try {
    const file = join(dir, 'ids.json');
    writeFileSync(file, '{ not json');
    const s = createStore(file);
    assert.equal(s.size(), 0);
    s.set('A', 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).A, 1);
    writeFileSync(file, JSON.stringify({ ok: 5, bad: 'x', neg: -2 }));
    assert.equal(createStore(file).size(), 1);         // only whole positive numbers are taken
    const readonly = createStore(join(dir, 'ids.json'), { fsImpl: { readFileSync: () => '{}', mkdirSync() { throw new Error('read-only'); }, writeFileSync() { throw new Error('read-only'); }, renameSync() {} } });
    assert.doesNotThrow(() => readonly.set('X', 9));
    assert.equal(readonly.get('X'), 9);                // still remembered in memory
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
