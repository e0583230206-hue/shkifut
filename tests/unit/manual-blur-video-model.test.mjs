// Unit tests for frontend/src/app/manual-blur-video-model.ts (Node runs the TypeScript directly).
//   node --test tests/unit/manual-blur-video-model.test.mjs
// The smooth movement must be the one the server renders: the first two tests read the files that scipy and the Go package produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pchipDerivatives, evalChannel, boxAt, addTrack, setKey, nearestKey, deleteKey, deleteTrack, setEnd, setInterp, sameTracks, toRequest, fromServer,
  TrackHistory, formatTime, recordFollow, scaleBox, MAX_TRACKS, MAX_KEYS, KEY_MERGE, PAD_FRAMES,
} from '../../frontend/src/app/manual-blur-video-model.ts';

const fx = (name) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name), 'utf8'));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const box = (x, y, w, h, type = 'rect') => ({ type, x, y, w, h });
const key = (t, x, y, w, h) => ({ t, x, y, w, h });
const track = (...keys) => ({ type: 'rect', keys, end: null, interp: 'pchip' });

test('the PCHIP movement equals scipy (8 cases, 1e-11)', () => {
  const cases = fx('pchip_vectors.json').cases;
  assert.ok(cases.length >= 8);
  for (const c of cases) {
    const d = pchipDerivatives(c.t, c.y);
    c.at.forEach((at, i) => assert.ok(near(evalChannel(c.t, c.y, d, at), c.expect[i], 1e-11), `${c.name} at ${at}`));
  }
});

test('whole tracks (window, hold, padding, clamping) equal the Go reference', () => {
  for (const c of fx('track_vectors.json').cases) {
    const tr = { type: c.track.type, keys: c.track.keys, end: c.track.end ?? null, interp: c.track.interp };
    c.at.forEach((at, i) => {
      const got = boxAt(tr, at, c.pad), want = c.expect[i];
      if (want[0] === -1) return assert.equal(got, null, `${c.name} at ${at}`);
      assert.ok(got, `${c.name} at ${at}`);
      [got.x, got.y, got.x + got.w, got.y + got.h].forEach((v, k) => assert.ok(near(v, want[k]), `${c.name} at ${at}: ${v} != ${want[k]}`));
    });
  }
});

test('padding is PAD_FRAMES frames', () => {
  assert.equal(PAD_FRAMES, 2);
});

test('a drawn track starts at the second of the drawing; a click away from a keyframe adds one, near one it changes it', () => {
  let tracks = addTrack([], box(0.1, 0.1, 0.2, 0.2), 2);
  assert.deepEqual(tracks[0].keys.map(k => k.t), [2]);
  tracks = setKey(tracks, 0, 4, box(0.5, 0.1, 0.2, 0.2));
  assert.deepEqual(tracks[0].keys.map(k => k.t), [2, 4]);
  const before = tracks;
  tracks = setKey(tracks, 0, 4 + KEY_MERGE / 2, box(0.6, 0.1, 0.2, 0.2));
  assert.equal(tracks[0].keys.length, 2, 'near an existing keyframe: changed, not added');
  assert.equal(tracks[0].keys[1].x, 0.6);
  assert.equal(before[0].keys[1].x, 0.5, 'the old list is not changed');
  tracks = setKey(tracks, 0, 1, box(0.05, 0.1, 0.2, 0.2));
  assert.deepEqual(tracks[0].keys.map(k => k.t), [1, 2, 4], 'before the first keyframe: the track starts earlier, keys stay sorted');
  tracks = setKey(tracks, 0, 3, box(0.3, 0.4, 0.2, 0.2));
  assert.deepEqual(tracks[0].keys.map(k => k.t), [1, 2, 3, 4]);
  assert.equal(nearestKey(tracks[0], 3.01), 2);
  assert.equal(nearestKey(tracks[0], 3.5), -1);
});

test('limits: tracks and keyframes', () => {
  let tracks = [];
  for (let i = 0; i < MAX_TRACKS; i++) tracks = addTrack(tracks, box(0.1, 0.1, 0.2, 0.2), i);
  assert.equal(tracks.length, MAX_TRACKS);
  assert.equal(addTrack(tracks, box(0.1, 0.1, 0.2, 0.2), 99), null);
  let t = [track(key(0, 0.1, 0.1, 0.2, 0.2))];
  for (let i = 1; i < MAX_KEYS; i++) t = setKey(t, 0, i, box(0.1, 0.1, 0.2, 0.2));
  assert.equal(t[0].keys.length, MAX_KEYS);
  assert.equal(setKey(t, 0, MAX_KEYS + 5, box(0.1, 0.1, 0.2, 0.2)), null);
  assert.ok(setKey(t, 0, 5, box(0.3, 0.3, 0.2, 0.2)), 'changing an existing keyframe is still possible at the limit');
});

test('deleting a keyframe; the last one removes the track; the end never ends up before the last keyframe', () => {
  let tracks = [track(key(1, 0.1, 0.1, 0.2, 0.2), key(3, 0.5, 0.1, 0.2, 0.2), key(5, 0.7, 0.1, 0.2, 0.2))];
  tracks = setEnd(tracks, 0, 5);
  tracks = deleteKey(tracks, 0, 2);
  assert.deepEqual(tracks[0].keys.map(k => k.t), [1, 3]);
  assert.equal(tracks[0].end, 5, 'the end stays');
  tracks = deleteKey(tracks, 0, 1);
  tracks = deleteKey(tracks, 0, 0);
  assert.equal(tracks.length, 0);
  const two = [{ ...track(key(1, 0.1, 0.1, 0.2, 0.2), key(3, 0.5, 0.1, 0.2, 0.2)), end: 3 }];
  assert.equal(deleteTrack(two, 0).length, 0);
});

test('the end: only after the last keyframe; null means the end of the video', () => {
  const tracks = [track(key(1, 0.1, 0.1, 0.2, 0.2), key(3, 0.5, 0.1, 0.2, 0.2))];
  assert.equal(setEnd(tracks, 0, 2), null, 'before the last keyframe');
  const ended = setEnd(tracks, 0, 4);
  assert.equal(ended[0].end, 4);
  assert.equal(boxAt(ended[0], 4.5, 0), null);
  assert.ok(boxAt(ended[0], 4, 0));
  const open = setEnd(ended, 0, null);
  assert.equal(open[0].end, null);
  assert.ok(boxAt(open[0], 800, 0), 'no end: the box stays to the end of the video');
  assert.equal(setInterp(tracks, 0, 'linear')[0].interp, 'linear');
});

test('the movement between two keyframes is smooth and stays between them', () => {
  const tr = track(key(0, 0.1, 0.1, 0.2, 0.2), key(2, 0.5, 0.1, 0.2, 0.2), key(4, 0.5, 0.1, 0.2, 0.2), key(6, 0.9, 0.1, 0.1, 0.2));
  let prev = boxAt(tr, 0, 0).x;
  for (let i = 1; i <= 120; i++) {
    const x = boxAt(tr, i / 20, 0).x;
    assert.ok(x >= prev - 1e-12, 'x never goes back: ' + i);
    prev = x;
  }
  assert.ok(near(boxAt(tr, 3, 0).x, 0.5), 'flat part stays flat');
});

test('toRequest rounds and leaves the end out when it is the end of the video; fromServer repairs', () => {
  const req = toRequest([{ type: 'ellipse', interp: 'linear', end: null, keys: [key(1.23456789, 0.1234567891, 0.2, 0.3, 0.4)] }, { type: 'rect', interp: 'pchip', end: 5, keys: [key(1, 0.1, 0.1, 0.2, 0.2)] }]);
  assert.equal(req[0].keys[0].t, 1.234568);
  assert.equal(req[0].keys[0].x, 0.123457);
  assert.ok(!('end' in req[0]) && req[1].end === 5);
  assert.deepEqual(fromServer(null), []);
  assert.deepEqual(fromServer([null, 5, { type: 'star', keys: [key(0, 0, 0, 1, 1)] }, { type: 'rect', keys: [] }, { type: 'rect', keys: [{ t: 'a' }] }]), []);
  const repaired = fromServer([{ type: 'rect', interp: 'bezier', end: 0.5, keys: [key(1, -0.2, 0.5, 2, 0.9), key(1.0001, 0.1, 0.1, 0.2, 0.2), key(3, 0.1, 0.1, 0.2, 0.2)] }]);
  assert.equal(repaired[0].interp, 'pchip');
  assert.equal(repaired[0].end, null, 'an end before the last keyframe is dropped');
  assert.deepEqual(repaired[0].keys.map(k => k.t), [1, 3], 'two keyframes at the same moment: the first stays');
  assert.deepEqual([repaired[0].keys[0].x, repaired[0].keys[0].w], [0, 1]);
});

test('history: undo, redo, equal states ignored, a new change ends the redo branch', () => {
  const a = [], b = [track(key(0, 0.1, 0.1, 0.2, 0.2))], c = [track(key(0, 0.1, 0.1, 0.2, 0.2), key(2, 0.4, 0.1, 0.2, 0.2))];
  const h = new TrackHistory(a);
  h.push(b); h.push(c); h.push(structuredClone(c));
  assert.ok(sameTracks(h.undo(), b));
  assert.ok(sameTracks(h.undo(), a));
  assert.ok(!h.canUndo && h.canRedo);
  assert.ok(sameTracks(h.redo(), b));
  h.push([track(key(5, 0.1, 0.1, 0.2, 0.2))]);
  assert.ok(!h.canRedo);
});

test('time display', () => {
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(65.43), '1:05.4');
  assert.equal(formatTime(-3), '0:00.0');
});

test('recordFollow: a straight pass becomes two keyframes, a turn keeps its corner, the keyframes outside the pass stay', () => {
  const tracks = [track(key(0, 0.1, 0.1, 0.2, 0.2), key(9, 0.5, 0.5, 0.2, 0.2))];
  const samples = [];
  for (let i = 0; i <= 20; i++) { const t = 1 + i * 0.1; samples.push({ t, box: box(0.1 + i * 0.01, 0.3, 0.2, 0.2) }); }
  for (let i = 1; i <= 20; i++) { const t = 3 + i * 0.1; samples.push({ t, box: box(0.3, 0.3 + i * 0.01, 0.2, 0.2) }); }
  const out = recordFollow(tracks, 0, samples);
  const ts = out[0].keys.map(k => k.t);
  assert.deepEqual(ts, [0, 1, 3, 5, 9]);   // the old key at 0 and at 9 stay, the pass 1..5 is three keys (start, corner, end)
  assert.ok(near(out[0].keys[2].x, 0.3, 1e-6) && near(out[0].keys[2].y, 0.3, 1e-6));
  assert.equal(out[0].keys[1].w, 0.2);
});

test('recordFollow: old keyframes inside the pass are replaced; a path too long for MAX_KEYS is thinned more or refused', () => {
  const tracks = [track(key(1, 0, 0, 0.1, 0.1), key(2, 0.9, 0.9, 0.1, 0.1), key(3, 0.5, 0.5, 0.1, 0.1))];
  const out = recordFollow(tracks, 0, [{ t: 1, box: box(0.2, 0.2, 0.1, 0.1) }, { t: 2.5, box: box(0.4, 0.4, 0.1, 0.1) }]);
  assert.deepEqual(out[0].keys.map(k => k.t), [1, 2.5, 3]);
  const wild = [];
  for (let i = 0; i < 2000; i++) wild.push({ t: i * 0.1, box: box(i % 2 ? 0.1 : 0.7, 0.2, 0.1, 0.1) });
  const r = recordFollow(tracks, 0, wild);
  assert.ok(r === null || r[0].keys.length <= MAX_KEYS);
  assert.equal(recordFollow(tracks, 5, wild), null);
  assert.equal(recordFollow(tracks, 0, []), null);
});

test('scaleBox: bigger / smaller around the centre, the same shape, inside the picture, never tiny', () => {
  const b = box(0.4, 0.4, 0.2, 0.1);
  const big = scaleBox(b, 1.5);
  assert.ok(near(big.w, 0.3) && near(big.h, 0.15) && near(big.x + big.w / 2, 0.5) && near(big.y + big.h / 2, 0.45));
  const small = scaleBox(b, 0.5);
  assert.ok(near(small.w, 0.1) && near(small.h, 0.05));
  const edge = scaleBox(box(0.85, 0.85, 0.1, 0.1), 3);
  assert.ok(edge.x >= 0 && edge.y >= 0 && edge.x + edge.w <= 1 + 1e-9 && edge.y + edge.h <= 1 + 1e-9 && near(edge.w, edge.h));
  assert.ok(scaleBox(b, 1e-6).h >= 0.015 - 1e-9);
  assert.ok(near(scaleBox(box(0, 0, 1, 0.5), 2).w, 1));
});
