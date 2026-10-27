// node --test bridge/capture.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { captureUntil, captureOn, captureLine, MAX_WINDOW_MS } = createRequire(import.meta.url)('./capture.js');

const NOW = 1_800_000_000_000;
const withFile = (content, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  try { const f = join(dir, 'capture-until'); if (content !== null) writeFileSync(f, content); return fn(f); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('the window is open only while its end time has not passed', () => {
  assert.equal(withFile(String(NOW + 600_000) + '\n', (f) => captureUntil(f, NOW)), NOW + 600_000);
  assert.equal(withFile(String(NOW - 1), (f) => captureUntil(f, NOW)), 0);
  assert.equal(withFile(String(NOW), (f) => captureUntil(f, NOW)), 0);
});

test('no file, an empty or a broken file means off', () => {
  assert.equal(withFile(null, (f) => captureUntil(f, NOW)), 0);
  for (const bad of ['', 'abc', '12.5', '-5', '{"until": 1}', 'NaN']) assert.equal(withFile(bad, (f) => captureUntil(f, NOW)), 0, bad);
});

test('a time more than 30 minutes ahead is ignored (a typo cannot leave it open)', () => {
  assert.equal(withFile(String(NOW + MAX_WINDOW_MS), (f) => captureUntil(f, NOW)), NOW + MAX_WINDOW_MS);
  assert.equal(withFile(String(NOW + MAX_WINDOW_MS + 1), (f) => captureUntil(f, NOW)), 0);
  assert.equal(withFile(String(Math.floor(NOW / 1000) + 600), (f) => captureUntil(f, NOW)), 0);   // seconds instead of milliseconds: in the past
});

test('the line has the sender, the chat and the text; my own messages say so', () => {
  const l = captureLine({ from: '120363429217173923@g.us', participant: '972501234567@c.us', body: 'שלום', _data: { Info: { PushName: 'דני' } } });
  assert.equal(l, '💬 דני › קבוצה 3923\nשלום');
  assert.equal(captureLine({ fromMe: true, from: '972500000000@c.us', to: '972509999999@c.us', body: 'היי' }), '💬 אני › אל 972509999999\nהיי');
  assert.equal(captureLine({ from: '972501112222@c.us', body: 'טקסט' }), '💬 972501112222 › שיחה אישית\nטקסט');
});

test('media is never carried over, only its kind; an empty message and status posts give nothing', () => {
  const l = captureLine({ from: '972501112222@c.us', hasMedia: true, body: 'כיתוב', media: { url: 'http://waha/api/files/x.jpg', mimetype: 'image/jpeg' } });
  assert.ok(l.includes('כיתוב') && l.includes('[מדיה: image/jpeg - לא נשלחה]') && !l.includes('http'), l);
  assert.equal(captureLine({ from: '972501112222@c.us', body: '  ' }), '');
  assert.equal(captureLine({ from: 'status@broadcast', body: 'סטטוס' }), '');
  assert.equal(captureLine({ from: '1@newsletter', body: 'x' }), '');
  assert.equal(captureLine({ body: 'x' }), '');
});

test('a very long text is cut', () => {
  assert.ok(captureLine({ from: '972501112222@c.us', body: 'א'.repeat(9000) }).length < 3700);
});

test('captureOn: the open file wins, otherwise the window decides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  try {
    const until = join(dir, 'capture-until'), all = join(dir, 'capture-all');
    assert.equal(captureOn(until, all, NOW), '');
    writeFileSync(until, String(NOW + 60_000));
    assert.equal(captureOn(until, all, NOW), 'window');
    assert.equal(captureOn(until, all, NOW + 120_000), '');       // the window has passed
    writeFileSync(all, '');
    assert.equal(captureOn(until, all, NOW + 120_000), 'all');    // open: no time limit
    rmSync(all);
    assert.equal(captureOn(until, all, NOW + 120_000), '');       // removing the file closes it
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('media: sent = the file travels with the message (no note), failed = noted, otherwise only the kind', () => {
  const m = { from: '972501112222@c.us', hasMedia: true, body: '', media: { mimetype: 'audio/ogg; codecs=opus' } };
  assert.equal(captureLine(m, 'sent'), '💬 972501112222 › שיחה אישית\n');
  assert.ok(captureLine(m, 'failed').includes('ההעלאה לצ׳אט נכשלה') && captureLine(m, 'failed').includes('audio/ogg'));
  assert.ok(captureLine(m).includes('[מדיה: audio/ogg - לא נשלחה]'));
  assert.equal(captureLine({ from: '972501112222@c.us', hasMedia: false, body: '' }, 'sent'), '');
});
