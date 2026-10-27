// The model of the manual video blur editor (no Angular here, so that it can be tested with node --test): tracks with keyframes, the smooth
// movement between them (PCHIP) and the edits the editor makes. The numbers must be exactly those of the server: the Go package
// backend/manualblur/video.go is the reference and the renderer (moderation/app/manual_video.py) has the same code; all three are tested against
// tests/fixtures/pchip_vectors.json (scipy) and tests/fixtures/track_vectors.json (the Go package).
//
// A track is one blurred area that moves: a shape with keyframes (a box at a second of the video). Before its first keyframe there is no blur,
// between two keyframes the box moves smoothly, after the last one it stays until the track's end (by default the end of the video).
import type { Shape, ShapeType } from './manual-blur-geometry';

export interface Key { t: number; x: number; y: number; w: number; h: number }
export type Interp = 'pchip' | 'linear';
export interface Track { type: ShapeType; keys: Key[]; end?: number | null; interp: Interp }

export const MAX_TRACKS = 30;
export const MAX_KEYS = 200;
export const MAX_VIDEO_SEC = 900;
/** The renderer starts the blur this many frames early and ends it this many frames late (so a frame of difference never shows). */
export const PAD_FRAMES = 2;
/** A keyframe closer than this (seconds) to an edit is the same keyframe: the edit changes it instead of adding one. */
export const KEY_MERGE = 0.04;
const MIN_GAP = 0.001;
const MIN_SIZE = 0.015;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function sign(v: number): number { return v > 0 ? 1 : v < 0 ? -1 : 0; }

function edge(h0: number, h1: number, m0: number, m1: number): number {
  const d = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
  if (sign(d) !== sign(m0)) return 0;
  if (sign(m0) !== sign(m1) && Math.abs(d) > 3 * Math.abs(m0)) return 3 * m0;
  return d;
}

/** The slopes at the keyframes of the monotone cubic (PCHIP): the same as scipy.interpolate.PchipInterpolator. */
export function pchipDerivatives(ts: number[], ys: number[]): number[] {
  const n = ts.length;
  const d: number[] = new Array(n).fill(0);
  if (n < 2) return d;
  const h: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) { h.push(ts[i + 1] - ts[i]); m.push((ys[i + 1] - ys[i]) / h[i]); }
  if (n === 2) { d[0] = m[0]; d[1] = m[0]; return d; }
  for (let k = 1; k < n - 1; k++) {
    if (sign(m[k - 1]) !== sign(m[k]) || m[k - 1] === 0 || m[k] === 0) { d[k] = 0; continue; }
    const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
    d[k] = (w1 + w2) / (w1 / m[k - 1] + w2 / m[k]);
  }
  d[0] = edge(h[0], h[1], m[0], m[1]);
  d[n - 1] = edge(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
  return d;
}

/** One channel (x, y, w or h) of a track at second t. */
export function evalChannel(ts: number[], ys: number[], ders: number[] | null, t: number): number {
  const first = ts[0], last = ts[ts.length - 1];
  if (t <= first) return ys[0];
  if (t >= last) return ys[ys.length - 1];
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  const h = ts[lo + 1] - ts[lo];
  const s = (t - ts[lo]) / h;
  if (!ders) return ys[lo] + (ys[lo + 1] - ys[lo]) * s;
  const s2 = s * s, s3 = s * s * s;
  return (2 * s3 - 3 * s2 + 1) * ys[lo] + (s3 - 2 * s2 + s) * h * ders[lo] + (-2 * s3 + 3 * s2) * ys[lo + 1] + (s3 - s2) * h * ders[lo + 1];
}

/**
 * The box of a track at second t, or null when the track is not active then. `pad` seconds are added before the first keyframe and after
 * the end (the editor shows what the track really is, pad 0; the renderer uses PAD_FRAMES / fps).
 */
export function boxAt(tr: Track, t: number, pad = 0): Shape | null {
  const ts = tr.keys.map(k => k.t);
  if (t < ts[0] - pad) return null;
  if (tr.end != null && t > tr.end + pad) return null;
  const ch = (name: 'x' | 'y' | 'w' | 'h') => {
    const ys = tr.keys.map(k => k[name]);
    return evalChannel(ts, ys, tr.interp === 'linear' ? null : pchipDerivatives(ts, ys), t);
  };
  const v = [ch('x'), ch('y'), ch('w'), ch('h')];
  const x1 = clamp01(v[0]), y1 = clamp01(v[1]), x2 = clamp01(v[0] + v[2]), y2 = clamp01(v[1] + v[3]);
  return { type: tr.type, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ---- edits (all return new lists; the old ones are not changed) ----

const keyOf = (t: number, b: { x: number; y: number; w: number; h: number }): Key => ({ t: round6(t), x: round6(b.x), y: round6(b.y), w: round6(b.w), h: round6(b.h) });

/** A new track whose first keyframe is at second t. Null when there are too many tracks. */
export function addTrack(tracks: Track[], box: Shape, t: number): Track[] | null {
  if (tracks.length >= MAX_TRACKS) return null;
  return [...tracks, { type: box.type, keys: [keyOf(t, box)], interp: 'pchip' }];
}

/**
 * The track changes its box at second t: an existing keyframe within KEY_MERGE of t is changed, otherwise a keyframe is added (before the first one
 * the track simply starts earlier). Null when it would need more than MAX_KEYS keyframes.
 */
export function setKey(tracks: Track[], idx: number, t: number, box: Shape): Track[] | null {
  const tr = tracks[idx];
  if (!tr) return null;
  const near = nearestKey(tr, t);
  let keys: Key[];
  if (near >= 0) {
    keys = tr.keys.map((k, i) => (i === near ? keyOf(k.t, box) : k));
  } else {
    if (tr.keys.length >= MAX_KEYS) return null;
    keys = [...tr.keys, keyOf(t, box)].sort((a, b) => a.t - b.t);
  }
  return tracks.map((x, i) => (i === idx ? { ...x, keys } : x));
}

/** While a box follows the mouse during playback, a position is recorded at most this often (seconds). */
export const FOLLOW_STEP = 0.1;
const FOLLOW_TOLERANCE = 0.003;   // a share of the picture: a recorded point on a straight line, closer than this to it, is dropped

export interface FollowSample { t: number; box: Shape }

/** The samples that matter: the ends, and every point a straight line between its neighbours would miss by more than `tol` (Douglas-Peucker in x, y and time). */
function thin(samples: FollowSample[], tol: number): FollowSample[] {
  const keep = new Array(samples.length).fill(false);
  keep[0] = keep[samples.length - 1] = true;
  const walk = (a: number, b: number) => {
    let worst = -1, worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const s = (samples[i].t - samples[a].t) / (samples[b].t - samples[a].t);
      const dx = Math.abs(samples[i].box.x - (samples[a].box.x + (samples[b].box.x - samples[a].box.x) * s));
      const dy = Math.abs(samples[i].box.y - (samples[a].box.y + (samples[b].box.y - samples[a].box.y) * s));
      const d = Math.max(dx, dy);
      if (d > worstD) { worst = i; worstD = d; }
    }
    if (worst >= 0) { keep[worst] = true; walk(a, worst); walk(worst, b); }
  };
  if (samples.length > 2) walk(0, samples.length - 1);
  return samples.filter((_, i) => keep[i]);
}

/**
 * A recording of the box of a track following the mouse while the video played: the keyframes from the first sample to the last are replaced by the
 * thinned samples (keyframes before and after stay). Null when it would need more than MAX_KEYS keyframes, or there is nothing to record.
 */
export function recordFollow(tracks: Track[], idx: number, samples: FollowSample[]): Track[] | null {
  const tr = tracks[idx];
  if (!tr || !samples.length) return null;
  const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
  const kept = tr.keys.filter(k => k.t < t0 - KEY_MERGE || k.t > t1 + KEY_MERGE);
  for (let tol = FOLLOW_TOLERANCE; tol < 0.2; tol *= 2) {
    const keys = [...kept, ...thin(samples, tol).map(s => keyOf(s.t, s.box))].sort((a, b) => a.t - b.t);
    if (keys.length <= MAX_KEYS) return tracks.map((x, i) => (i === idx ? { ...x, keys } : x));
  }
  return null;
}

/** The box made bigger (f > 1) or smaller (f < 1) around its centre, keeping its shape; it stays inside the picture and not smaller than MIN_SIZE. */
export function scaleBox(b: Shape, f: number): Shape {
  const lo = MIN_SIZE / Math.min(b.w, b.h), hi = 1 / Math.max(b.w, b.h);
  const k = lo > hi ? 1 : Math.min(hi, Math.max(lo, f));
  const w = b.w * k, h = b.h * k;
  const x = Math.min(1 - w, Math.max(0, b.x + b.w / 2 - w / 2)), y = Math.min(1 - h, Math.max(0, b.y + b.h / 2 - h / 2));
  return { ...b, x, y, w, h };
}

/** The index of the keyframe within KEY_MERGE of second t, or -1. */
export function nearestKey(tr: Track, t: number): number {
  let best = -1, bestD = KEY_MERGE;
  tr.keys.forEach((k, i) => {
    const d = Math.abs(k.t - t);
    if (d < bestD) { best = i; bestD = d; }
  });
  return best;
}

/** Remove a keyframe; the last one removes the track. */
export function deleteKey(tracks: Track[], idx: number, keyIdx: number): Track[] {
  const tr = tracks[idx];
  if (!tr) return tracks;
  if (tr.keys.length <= 1) return tracks.filter((_, i) => i !== idx);
  const keys = tr.keys.filter((_, i) => i !== keyIdx);
  let end = tr.end;
  if (end != null && end < keys[keys.length - 1].t) end = keys[keys.length - 1].t;
  return tracks.map((x, i) => (i === idx ? { ...x, keys, end } : x));
}

export function deleteTrack(tracks: Track[], idx: number): Track[] {
  return tracks.filter((_, i) => i !== idx);
}

/** The second at which the blur of a track ends (null = the end of the video). Null result when it is before the last keyframe. */
export function setEnd(tracks: Track[], idx: number, end: number | null): Track[] | null {
  const tr = tracks[idx];
  if (!tr) return null;
  if (end != null && end < tr.keys[tr.keys.length - 1].t) return null;
  return tracks.map((x, i) => (i === idx ? { ...x, end: end == null ? null : round6(end) } : x));
}

export function setInterp(tracks: Track[], idx: number, interp: Interp): Track[] {
  return tracks.map((x, i) => (i === idx ? { ...x, interp } : x));
}

export function sameTracks(a: Track[], b: Track[]): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(tracks: Track[]) {
  return tracks.map(t => ({ type: t.type, interp: t.interp, end: t.end == null ? null : t.end, keys: t.keys.map(k => [k.t, k.x, k.y, k.w, k.h]) }));
}

/** What is sent to the server: the end is left out when it is the end of the video. */
export function toRequest(tracks: Track[]) {
  return tracks.map(t => {
    const out: { type: ShapeType; keys: Key[]; interp: Interp; end?: number } = { type: t.type, keys: t.keys.map(k => keyOf(k.t, k)), interp: t.interp };
    if (t.end != null) out.end = round6(t.end);
    return out;
  });
}

/** Tracks from the server, made safe to edit (a broken entry is dropped). */
export function fromServer(list: unknown): Track[] {
  if (!Array.isArray(list)) return [];
  const out: Track[] = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const tr = it as Partial<Track>;
    if ((tr.type !== 'rect' && tr.type !== 'ellipse') || !Array.isArray(tr.keys) || !tr.keys.length) continue;
    const keys: Key[] = [];
    for (const k of tr.keys) {
      if (!k || ![k.t, k.x, k.y, k.w, k.h].every(v => typeof v === 'number' && Number.isFinite(v))) continue;
      const x1 = clamp01(k.x), y1 = clamp01(k.y), x2 = clamp01(k.x + k.w), y2 = clamp01(k.y + k.h);
      if (x2 - x1 < MIN_SIZE / 3 || y2 - y1 < MIN_SIZE / 3 || k.t < 0) continue;
      if (keys.length && k.t - keys[keys.length - 1].t < MIN_GAP) continue;
      keys.push({ t: k.t, x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
    if (!keys.length) continue;
    const end = typeof tr.end === 'number' && Number.isFinite(tr.end) && tr.end >= keys[keys.length - 1].t ? tr.end : null;
    out.push({ type: tr.type, keys: keys.slice(0, MAX_KEYS), end, interp: tr.interp === 'linear' ? 'linear' : 'pchip' });
  }
  return out.slice(0, MAX_TRACKS);
}

/** Undo / redo over snapshots of the whole list of tracks. */
export class TrackHistory {
  private past: Track[][] = [];
  private future: Track[][] = [];
  private present: Track[];
  private limit: number;

  constructor(present: Track[], limit = 100) {
    this.present = present;
    this.limit = limit;
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  push(next: Track[]) {
    if (sameTracks(this.present, next)) return;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
    this.future = [];
  }

  undo(): Track[] {
    const prev = this.past.pop();
    if (prev) { this.future.push(this.present); this.present = prev; }
    return this.present;
  }

  redo(): Track[] {
    const next = this.future.pop();
    if (next) { this.past.push(this.present); this.present = next; }
    return this.present;
  }
}

/** mm:ss.s for the time display. */
export function formatTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
