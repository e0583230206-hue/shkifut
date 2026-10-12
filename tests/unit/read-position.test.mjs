// Unit tests for frontend/src/app/read-position.ts.   node --test tests/unit/read-position.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstUnreadId, unreadCount, newestVisibleId } from '../../frontend/src/app/read-position.ts';

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
