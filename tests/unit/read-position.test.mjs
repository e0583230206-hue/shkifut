// Unit tests for frontend/src/app/read-position.ts.   node --test tests/unit/read-position.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstUnreadId, unreadCount, newestVisibleId, isAfterMarker, firstUnreadByTime, unreadCountByTime, newestVisibleByTime, advanceMarker, readMarker, writeMarker } from '../../frontend/src/app/read-position.ts';

test('first unread is the oldest id after the last read, even with gaps (deleted messages)', () => {
  assert.equal(firstUnreadId([50, 49, 47, 44, 40], 44), 47);
  assert.equal(firstUnreadId([50, 49, 47], 45), 47);
});

test('no divider when nothing is unread or on a first visit', () => {
  assert.equal(firstUnreadId([50, 49], 50), undefined);
  assert.equal(firstUnreadId([50, 49], 0), undefined);
});

test('unread count', () => {
  assert.equal(unreadCount([50, 49, 47, 44], 44), 3);
  assert.equal(unreadCount([50, 49], 0), 0);
});

test('newest visible message ignores ones hidden under the header or below the screen', () => {
  const items = [
    { id: 10, top: 20, bottom: 90 },     // under the header (header ends at 100)
    { id: 11, top: 120, bottom: 300 },   // visible
    { id: 12, top: 600, bottom: 800 },   // partly visible
    { id: 13, top: 1100, bottom: 1300 }, // below the screen (height 1000)
  ];
  assert.equal(newestVisibleId(items, 100, 1000), 12);
  assert.equal(newestVisibleId([], 100, 1000), 0);
});

// ---- time-based read position (released-from-waiting messages keep a low id but a new time) ----
const T = (s) => Date.parse(`2026-11-18T10:00:${String(s).padStart(2, '0')}Z`);

test('a message released later keeps its low id but is unread (the bug this fixes)', () => {
  const marker = { id: 298, at: T(10) };
  const items = [{ id: 646, at: T(50) }, { id: 647, at: T(40) }, { id: 657, at: T(55) }];
  assert.equal(unreadCountByTime(items, marker), 3);
  assert.equal(firstUnreadByTime(items, marker), 647, 'oldest unread by time, not by id');
});

test('a released message that was released before the marker is read (the marker is a time cut-off)', () => {
  const marker = { id: 657, at: T(30) };
  assert.equal(isAfterMarker({ id: 646, at: T(20) }, marker), false);
});

test('an old message never becomes new because its id is high', () => {
  const marker = { id: 300, at: T(50) };
  assert.equal(isAfterMarker({ id: 900, at: T(10) }, marker), false);
});

test('equal timestamps are ordered by id, deterministically', () => {
  const marker = { id: 50, at: T(20) };
  assert.equal(isAfterMarker({ id: 49, at: T(20) }, marker), false);
  assert.equal(isAfterMarker({ id: 51, at: T(20) }, marker), true);
  assert.equal(firstUnreadByTime([{ id: 53, at: T(20) }, { id: 51, at: T(20) }], marker), 51);
});

test('a legacy marker (id only) keeps the id rule until its time is known', () => {
  const legacy = { id: 49 };
  assert.equal(isAfterMarker({ id: 50 }, legacy), true);
  assert.equal(isAfterMarker({ id: 48 }, legacy), false);
  assert.equal(isAfterMarker({ id: 52, at: T(5) }, legacy), true);
});

test('the marker only moves forward, by time', () => {
  const m = { id: 10, at: T(9) };
  assert.deepEqual(advanceMarker(m, { id: 11, at: T(5) }), m, 'an older message does not move it back');
  assert.deepEqual(advanceMarker(m, { id: 12, at: T(15) }), { id: 12, at: T(15) });
  assert.deepEqual(advanceMarker({ id: 0 }, { id: 7, at: T(1) }), { id: 7, at: T(1) }, 'first visit');
  assert.deepEqual(advanceMarker({ id: 40 }, { id: 41, at: T(1) }), { id: 41, at: T(1) }, 'legacy marker is upgraded when a newer message is seen');
});

test('the newest visible message is the newest by time, among those on screen', () => {
  const items = [
    { id: 646, at: T(50), top: 120, bottom: 200 },  // visible, newest by time
    { id: 657, at: T(30), top: 210, bottom: 300 },  // visible, older by time (higher id)
    { id: 900, at: T(60), top: 600, bottom: 700 },  // newer but below the screen
  ];
  assert.equal(newestVisibleByTime(items, 100, 500)?.id, 646);
  assert.equal(newestVisibleByTime([{ id: 1, at: T(1), top: 0, bottom: 10 }], 100, 500), undefined);
});

test('no unread and no divider without a marker', () => {
  assert.equal(firstUnreadByTime([{ id: 5, at: T(1) }], { id: 0 }), undefined);
  assert.equal(unreadCountByTime([{ id: 5, at: T(1) }], { id: 0 }), 0);
});

test('the marker round-trips through storage, and an old storage with only the id still reads', () => {
  const store = new Map();
  writeMarker((k, v) => store.set(k, v), { id: 646, at: T(50) });
  assert.deepEqual(readMarker((k) => store.get(k) ?? null), { id: 646, at: T(50) });
  const legacy = new Map([['lastReadMessage', '298']]);
  assert.deepEqual(readMarker((k) => legacy.get(k) ?? null), { id: 298, at: undefined });
  assert.deepEqual(readMarker(() => null), { id: 0, at: undefined });
});
