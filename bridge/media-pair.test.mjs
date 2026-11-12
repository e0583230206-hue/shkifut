// node --test bridge/media-pair.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createPairer, parseSenders, quality, pick, kindOf } = createRequire(import.meta.url)('./media-pair.js');

const BOT = '120542803808311';
const ev = (id, over = {}) => ({ id, body: 'שקועים בלימוד.', hasMedia: true, media: { mimetype: 'image/jpeg' }, ...over });
const withSize = (w, h) => ({ _data: { Message: { imageMessage: { width: w, height: h } } } });
// a timer that runs when the test says so (no real waiting)
const fakeTimers = () => { const q = []; return { setTimer: (fn) => q.push(fn), fire: () => q.splice(0).forEach((f) => f()) }; };

test('the senders list: digits only, empty parts dropped', () => {
  assert.deepEqual(parseSenders('120542803808311, +972-50-000, ,x'), ['120542803808311', '97250000']);
  assert.deepEqual(parseSenders(''), []);
  assert.deepEqual(parseSenders(undefined), []);
});

test('quality: pixels first, then the size of the file, then 0', () => {
  assert.equal(quality(ev('a', withSize(1920, 1080))), 1920 * 1080);
  assert.equal(quality(ev('b', { _data: { Message: { videoMessage: { width: 1280, height: 720 } } } })), 1280 * 720);
  assert.equal(quality(ev('c', { _data: { Message: { imageMessage: { fileLength: '5000' } } } })), 5000);
  assert.equal(quality(ev('d', { media: { fileLength: 7 } })), 7);
  assert.equal(quality(ev('e')), 0);
  assert.equal(quality(null), 0);
});

test('pick: the larger picture wins; equal or unknown: the later one', () => {
  const low = ev('low', withSize(1920, 1080)), high = ev('high', withSize(3840, 2160));
  assert.equal(pick([low, high]).id, 'high');
  assert.equal(pick([high, low]).id, 'high'); // the order does not matter when the sizes are known
  assert.equal(pick([ev('x'), ev('y')]).id, 'y');
  assert.equal(pick([ev('only')]).id, 'only');
});

test('the kind of media', () => {
  assert.equal(kindOf({ media: { mimetype: 'video/mp4' } }), 'video');
  assert.equal(kindOf({ media: { mimetype: 'image/jpeg' } }), 'image');
  assert.equal(kindOf({ media: { mimetype: 'audio/ogg' } }), 'other');
  assert.equal(kindOf({}), 'media');
});

test('nothing is paired by default, for another sender, or without a real caption', () => {
  const off = createPairer({ senders: [], windowMs: 30000 });
  assert.equal(off.keyOf(ev('a'), BOT), '');
  const on = createPairer({ senders: [BOT], windowMs: 30000 });
  assert.equal(on.keyOf(ev('a'), '972500000000'), '');
  assert.equal(on.keyOf(ev('a', { body: '' }), BOT), '');
  assert.equal(on.keyOf(ev('a', { body: 'קצר' }), BOT), '');
  assert.equal(on.keyOf(ev('a', { body: undefined }), BOT), '');
  assert.notEqual(on.keyOf(ev('a'), BOT), '');
  assert.equal(createPairer({ senders: [BOT], windowMs: 0 }).keyOf(ev('a'), BOT), '');
});

test('the same sender, kind and caption (spaces ignored) share a key; a different caption or kind does not', () => {
  const p = createPairer({ senders: [BOT], windowMs: 1 });
  assert.equal(p.keyOf(ev('a'), BOT), p.keyOf(ev('b', { body: '  שקועים   בלימוד.  ' }), BOT));
  assert.notEqual(p.keyOf(ev('a'), BOT), p.keyOf(ev('b', { body: 'כיתוב אחר לגמרי' }), BOT));
  assert.notEqual(p.keyOf(ev('a'), BOT), p.keyOf(ev('b', { media: { mimetype: 'video/mp4' } }), BOT));
});

test('two qualities of one media: both callers get the same answer, the better one', async () => {
  const t = fakeTimers();
  const p = createPairer({ senders: [BOT], windowMs: 30000, setTimer: t.setTimer });
  const low = ev('low', withSize(1920, 1080)), high = ev('high', withSize(3840, 2160));
  const key = p.keyOf(low, BOT);
  const a = p.hold(key, low);
  const b = p.hold(key, high);
  assert.equal(p.size(), 1);
  t.fire();
  assert.equal((await a).id, 'high');
  assert.equal((await b).id, 'high');
  assert.equal(p.size(), 0);
});

test('a single media: after the wait it is the winner itself', async () => {
  const t = fakeTimers();
  const p = createPairer({ senders: [BOT], windowMs: 30000, setTimer: t.setTimer });
  const one = ev('one', withSize(746, 1280));
  const a = p.hold(p.keyOf(one, BOT), one);
  t.fire();
  assert.equal((await a).id, 'one');
});

test('a later media with the same key (after the window) starts a new wait', async () => {
  const t = fakeTimers();
  const p = createPairer({ senders: [BOT], windowMs: 30000, setTimer: t.setTimer });
  const first = ev('first'), second = ev('second');
  const a = p.hold(p.keyOf(first, BOT), first);
  t.fire();
  assert.equal((await a).id, 'first');
  const b = p.hold(p.keyOf(second, BOT), second);
  t.fire();
  assert.equal((await b).id, 'second');
});

test('three versions of one media: still one answer', async () => {
  const t = fakeTimers();
  const p = createPairer({ senders: [BOT], windowMs: 30000, setTimer: t.setTimer });
  const v = [ev('1', withSize(640, 360)), ev('3', withSize(3840, 2160)), ev('2', withSize(1280, 720))];
  const k = p.keyOf(v[0], BOT);
  const all = v.map((e) => p.hold(k, e));
  t.fire();
  const ids = (await Promise.all(all)).map((e) => e.id);
  assert.deepEqual(ids, ['3', '3', '3']);
});
