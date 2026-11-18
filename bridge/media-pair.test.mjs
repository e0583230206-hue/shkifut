// node --test bridge/media-pair.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createPairer, parseSenders, quality, kindOf, ratioOf, sameShape } = createRequire(import.meta.url)('./media-pair.js');

const BOT = '120542803808311';
const ev = (id, over = {}) => ({ id, body: 'שקועים בלימוד.', hasMedia: true, media: { mimetype: 'image/jpeg' }, ...over });
const withSize = (w, h) => ({ _data: { Message: { imageMessage: { width: w, height: h } } } });
const clock = () => { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; };

test('the senders list: digits only, * kept, empty parts dropped', () => {
  assert.deepEqual(parseSenders('120542803808311, +972-50-000, ,x'), ['120542803808311', '97250000']);
  assert.deepEqual(parseSenders('*'), ['*']);
  assert.deepEqual(parseSenders(''), []);
  assert.deepEqual(parseSenders(undefined), []);
});

test('quality and ratio come from WhatsApp data; unknown = 0', () => {
  assert.equal(quality(ev('a', withSize(1920, 1080))), 1920 * 1080);
  assert.equal(quality(ev('c', { _data: { Message: { imageMessage: { fileLength: '5000' } } } })), 5000);
  assert.equal(quality(null), 0);
  assert.ok(Math.abs(ratioOf(ev('a', withSize(1920, 1080))) - 16 / 9) < 1e-9);
  assert.equal(ratioOf(ev('b')), 0);
});

test('same shape: 16:9 in two sizes yes, 16:9 vs 9:16 no, unknown yes', () => {
  assert.equal(sameShape(1920 / 1080, 3840 / 2160), true);
  assert.equal(sameShape(854 / 480, 1280 / 720), true); // 1.779 vs 1.778
  assert.equal(sameShape(16 / 9, 9 / 16), false);
  assert.equal(sameShape(0, 16 / 9), true);
});

test('the kind of media', () => {
  assert.equal(kindOf({ media: { mimetype: 'video/mp4' } }), 'video');
  assert.equal(kindOf({ media: { mimetype: 'image/jpeg' } }), 'image');
  assert.equal(kindOf({ media: { mimetype: 'audio/ogg' } }), 'other');
  assert.equal(kindOf({}), 'media');
});

test('nothing is paired by default, for an unnamed sender, or without a real caption', () => {
  assert.equal(createPairer({ senders: [] }).keyOf(ev('a'), BOT), '');
  const on = createPairer({ senders: [BOT] });
  assert.equal(on.keyOf(ev('a'), '972500000000'), '');
  assert.equal(on.keyOf(ev('a', { body: '' }), BOT), '');
  assert.equal(on.keyOf(ev('a', { body: 'קצר' }), BOT), '');
  assert.notEqual(on.keyOf(ev('a'), BOT), '');
  assert.equal(createPairer({ senders: [BOT], windowMs: 0 }).keyOf(ev('a'), BOT), '');
});

test("'*' pairs every sender, each sender separately", () => {
  const p = createPairer({ senders: ['*'] });
  assert.notEqual(p.keyOf(ev('a'), '972500000000'), '');
  assert.notEqual(p.keyOf(ev('a'), '972500000000'), p.keyOf(ev('a'), '972511111111'));
});

test('the same sender, kind and caption (spaces ignored) share a key; a different caption or kind does not', () => {
  const p = createPairer({ senders: [BOT] });
  assert.equal(p.keyOf(ev('a'), BOT), p.keyOf(ev('b', { body: '  שקועים   בלימוד.  ' }), BOT));
  assert.notEqual(p.keyOf(ev('a'), BOT), p.keyOf(ev('b', { body: 'כיתוב אחר לגמרי' }), BOT));
  assert.notEqual(p.keyOf(ev('a'), BOT), p.keyOf(ev('b', { media: { mimetype: 'video/mp4' } }), BOT));
});

test('two qualities: the first is published at once, the second is skipped', async () => {
  const p = createPairer({ senders: [BOT] });
  const low = ev('low', withSize(1920, 1080)), high = ev('high', withSize(3840, 2160));
  const key = p.keyOf(low, BOT);
  assert.equal((await p.hold(key, low)).id, 'low');
  assert.equal((await p.hold(key, high)).id, 'low'); // high is not the winner -> the bridge skips it
});

test('a late twin (31 minutes) is caught; after the window it is a new media', async () => {
  const c = clock();
  const p = createPairer({ senders: [BOT], windowMs: 3600000, now: c.now });
  const a = ev('a', withSize(854, 480)), b = ev('b', withSize(1280, 720)), later = ev('later', withSize(854, 480));
  const key = p.keyOf(a, BOT);
  await p.hold(key, a);
  c.tick(31 * 60000);
  assert.equal((await p.hold(key, b)).id, 'a');
  c.tick(61 * 60000);
  assert.equal((await p.hold(key, later)).id, 'later');
});

test('the same caption with a different picture shape is a different media', async () => {
  const p = createPairer({ senders: [BOT] });
  const wide = ev('wide', withSize(1920, 1080)), tall = ev('tall', withSize(1080, 1920));
  const key = p.keyOf(wide, BOT);
  assert.equal((await p.hold(key, wide)).id, 'wide');
  assert.equal((await p.hold(key, tall)).id, 'tall');
});

test('unknown shape: the caption and the time decide', async () => {
  const p = createPairer({ senders: [BOT] });
  const a = ev('a'), b = ev('b');
  const key = p.keyOf(a, BOT);
  await p.hold(key, a);
  assert.equal((await p.hold(key, b)).id, 'a');
});
