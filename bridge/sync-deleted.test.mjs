import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { findGone } = createRequire(import.meta.url)('./sync-deleted.js');

const entries = (...pairs) => pairs.map(([s, id]) => [s, id]);
const run = (o) => findGone({ pending: new Map(), ...o });

test('a message that is missing once is only noted, and deleted when it is missing again', () => {
  const e = entries(['A', 10], ['B', 11], ['C', 12]);
  const present = new Set(['A', 'C']);
  const first = run({ entries: e, present });
  assert.deepEqual(first.gone, []);
  assert.equal(first.pending.get('B'), 1);
  const second = run({ entries: e, present, pending: first.pending });
  assert.deepEqual(second.gone, [['B', 11]]);
});

test('a message that comes back is forgotten', () => {
  const e3 = entries(['A', 10], ['B', 11], ['C', 12]);
  const miss = run({ entries: e3, present: new Set(['A', 'C']) });
  assert.equal(miss.pending.get('B'), 1);
  const back = run({ entries: e3, present: new Set(['A', 'B', 'C']), pending: miss.pending });
  assert.equal(back.pending.size, 0);
  assert.deepEqual(back.gone, []);
});

test('an empty history judges nothing and keeps what it knew', () => {
  const pending = new Map([['B', 1]]);
  const r = run({ entries: entries(['A', 10], ['B', 11]), present: new Set(), pending });
  assert.deepEqual(r.gone, []);
  assert.equal(r.judged, false);
  assert.equal(r.pending.get('B'), 1);
});

test('a history where none of the recent messages is present is a failure, not a deletion of everything', () => {
  const r = run({ entries: entries(['A', 10], ['B', 11]), present: new Set(['X', 'Y']), pending: new Map([['A', 5], ['B', 5]]) });
  assert.deepEqual(r.gone, []);
  assert.equal(r.judged, false);
});

test('a message older than the oldest one still in the history is not judged (it may be outside the window)', () => {
  const e = entries(['OLD', 1], ['A', 10], ['B', 11]);
  const present = new Set(['A', 'B']);
  const r = run({ entries: e, present, pending: new Map([['OLD', 5]]) });
  assert.deepEqual(r.gone, []);
  assert.equal(r.pending.has('OLD'), false);
});

test('only the latest messages are looked at', () => {
  const many = Array.from({ length: 200 }, (_, i) => [`M${i}`, i + 1]);
  const present = new Set(many.slice(150).map(([s]) => s).filter(s => s !== 'M190'));
  const first = findGone({ entries: many, present, pending: new Map(), recent: 80 });
  assert.equal([...first.pending.keys()].join(), 'M190');
});

test('no more than maxPerCycle deletions at a time, the oldest first, the rest wait', () => {
  const e = entries(['A', 1], ['B', 2], ['C', 3], ['D', 4], ['E', 5], ['Z', 6]);
  const present = new Set(['A', 'Z']);
  const pending = new Map([['B', 1], ['C', 1], ['D', 1], ['E', 1]]);
  const r = run({ entries: e, present, pending, maxPerCycle: 3 });
  assert.deepEqual(r.gone.map(([s]) => s), ['B', 'C', 'D']);
  assert.equal(r.pending.get('E'), 2);
});

test('nothing is deleted when every message is present', () => {
  const r = run({ entries: entries(['A', 1], ['B', 2]), present: new Set(['A', 'B']) });
  assert.deepEqual(r.gone, []);
  assert.equal(r.pending.size, 0);
});
