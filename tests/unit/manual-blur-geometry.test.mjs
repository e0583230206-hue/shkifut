// Unit tests for frontend/src/app/manual-blur-geometry.ts (Node runs the TypeScript directly).
//   node --test tests/unit/manual-blur-geometry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromDrag, move, resize, contains, hit, sameShapes, toRequest, fromServer, History, MIN_SIZE, MAX_SHAPES } from '../../frontend/src/app/manual-blur-geometry.ts';

const rect = (x, y, w, h) => ({ type: 'rect', x, y, w, h });
const ell = (x, y, w, h) => ({ type: 'ellipse', x, y, w, h });
const inside = (s) => s.x >= 0 && s.y >= 0 && s.x + s.w <= 1 + 1e-9 && s.y + s.h <= 1 + 1e-9;
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('a drag in any direction makes the same shape; a click makes none', () => {
  const a = fromDrag('rect', 0.2, 0.3, 0.6, 0.7), b = fromDrag('rect', 0.6, 0.7, 0.2, 0.3), c = fromDrag('rect', 0.6, 0.3, 0.2, 0.7);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.ok(near(a.w, 0.4) && near(a.h, 0.4));
  assert.equal(fromDrag('rect', 0.5, 0.5, 0.5, 0.5), null);
  assert.equal(fromDrag('ellipse', 0.5, 0.5, 0.5 + MIN_SIZE / 2, 0.9), null);
});

test('a drag that leaves the picture is cut at its edge', () => {
  const s = fromDrag('rect', 0.8, 0.8, 1.7, -0.5);
  assert.ok(inside(s));
  assert.ok(near(s.x, 0.8) && near(s.w, 0.2) && near(s.y, 0) && near(s.h, 0.8));
});

test('move keeps the shape inside the picture and does not squeeze it', () => {
  const s = rect(0.5, 0.5, 0.3, 0.2);
  const m = move(s, 0.5, -0.9);
  assert.ok(near(m.x, 0.7) && near(m.y, 0) && m.w === 0.3 && m.h === 0.2);
  assert.ok(inside(move(s, -2, 2)));
});

test('resize: each handle moves only its edges', () => {
  const s = rect(0.2, 0.2, 0.4, 0.4);
  const e = resize(s, 'e', 0.1, 0.5);
  assert.ok(near(e.w, 0.5) && e.x === 0.2 && e.y === 0.2 && e.h === 0.4, 'e changes only the width');
  const n = resize(s, 'n', 0.5, -0.1);
  assert.ok(near(n.y, 0.1) && near(n.h, 0.5) && n.x === 0.2 && n.w === 0.4, 'n changes only the top');
  const se = resize(s, 'se', 0.1, 0.1);
  assert.ok(near(se.w, 0.5) && near(se.h, 0.5) && se.x === 0.2 && se.y === 0.2);
  const nw = resize(s, 'nw', -0.1, -0.1);
  assert.ok(near(nw.x, 0.1) && near(nw.y, 0.1) && near(nw.w, 0.5) && near(nw.h, 0.5));
});

test('resize: dragging past the opposite edge flips the shape', () => {
  const s = rect(0.4, 0.4, 0.2, 0.2);
  const f = resize(s, 'e', -0.5, 0);   // right edge goes to 0.1, left edge stays at 0.4
  assert.ok(near(f.x, 0.1) && near(f.w, 0.3), JSON.stringify(f));
});

test('resize: never smaller than the minimum, never outside the picture', () => {
  const s = rect(0.4, 0.4, 0.2, 0.2);
  const t = resize(s, 'e', -0.19, 0);
  assert.ok(t.w >= MIN_SIZE - 1e-9 && t.x === 0.4, JSON.stringify(t));
  const u = resize(s, 'w', 0.19, 0);
  assert.ok(u.w >= MIN_SIZE - 1e-9 && near(u.x + u.w, 0.6), JSON.stringify(u));
  for (const h of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    for (const [dx, dy] of [[5, 5], [-5, -5], [5, -5], [-5, 5], [0.0001, 0.0001]]) {
      const r = resize(s, h, dx, dy);
      assert.ok(inside(r), `${h} ${dx},${dy}: ${JSON.stringify(r)}`);
      assert.ok(r.w >= MIN_SIZE - 1e-9 && r.h >= MIN_SIZE - 1e-9, `${h} ${dx},${dy} too small: ${JSON.stringify(r)}`);
    }
  }
});

test('an ellipse is hit only inside the ellipse, not in the corners of its box', () => {
  const e = ell(0.2, 0.2, 0.4, 0.4);
  assert.ok(contains(e, 0.4, 0.4));
  assert.ok(!contains(e, 0.21, 0.21), 'corner of the box');
  assert.ok(contains(rect(0.2, 0.2, 0.4, 0.4), 0.21, 0.21));
  assert.ok(!contains(e, 0.7, 0.4));
});

test('hit returns the shape drawn last (on top), or -1', () => {
  const list = [rect(0.1, 0.1, 0.5, 0.5), rect(0.3, 0.3, 0.5, 0.5)];
  assert.equal(hit(list, 0.4, 0.4), 1);
  assert.equal(hit(list, 0.15, 0.15), 0);
  assert.equal(hit(list, 0.95, 0.95), -1);
  assert.equal(hit([], 0.5, 0.5), -1);
});

test('toRequest rounds, and fromServer repairs what the server could send', () => {
  const r = toRequest([rect(0.123456789, 0.2, 0.3, 0.4)]);
  assert.equal(r[0].x, 0.123457);
  assert.deepEqual(fromServer(null), []);
  assert.deepEqual(fromServer([{ type: 'star', x: 0, y: 0, w: 1, h: 1 }, { type: 'rect', x: 'a', y: 0, w: 1, h: 1 }, null, 5]), []);
  const clipped = fromServer([{ type: 'rect', x: -0.2, y: 0.5, w: 2, h: 0.9 }]);
  assert.deepEqual(clipped, [rect(0, 0.5, 1, 0.5)]);
  assert.equal(fromServer(Array.from({ length: 80 }, () => rect(0.1, 0.1, 0.2, 0.2))).length, MAX_SHAPES);
});

test('history: undo, redo, a change after undo drops the redo branch, equal states are ignored', () => {
  const a = [], b = [rect(0.1, 0.1, 0.2, 0.2)], c = [rect(0.1, 0.1, 0.2, 0.2), ell(0.5, 0.5, 0.2, 0.2)];
  const h = new History(a);
  assert.ok(!h.canUndo && !h.canRedo);
  h.push(b); h.push(c);
  h.push(structuredClone(c));                                       // same as the current: nothing recorded
  assert.equal(h.undo().length, 1);
  assert.equal(h.undo().length, 0);
  assert.ok(!h.canUndo && h.canRedo);
  assert.equal(h.undo().length, 0, 'undo at the start does nothing');
  assert.equal(h.redo().length, 1);
  h.push([rect(0.6, 0.6, 0.1, 0.1)]);
  assert.ok(!h.canRedo, 'a new change ends the redo branch');
  assert.ok(sameShapes(h.undo(), b));
  const limited = new History([], 3);
  for (let i = 1; i <= 6; i++) limited.push([rect(0.1, 0.1, i / 20, 0.2)]);
  let undos = 0;
  while (limited.canUndo) { limited.undo(); undos++; }
  assert.equal(undos, 3, 'history is limited');
});
