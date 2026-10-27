// Geometry and undo history of the manual blur editor (no Angular here, so that it can be tested with node --test).
// All numbers are shares of the picture (0..1), like the shapes the server stores: x, y = top-left corner, w, h = size.
// An "ellipse" is the ellipse inside its box.

export type ShapeType = 'rect' | 'ellipse' | 'brush';

export interface Shape {
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A brush stroke (type 'brush') has no box: r is the radius of the brush (a share of the WIDTH of the picture) and pts the points it went through. */
  r?: number;
  pts?: [number, number][];
}

export const MAX_BRUSH_POINTS = 2000;
export const MIN_BRUSH_R = 0.003;
export const MAX_BRUSH_R = 0.25;

/** Smallest shape the editor makes (the server accepts 0.5%: a click, not a shape, is below this). */
export const MIN_SIZE = 0.015;
export const MAX_SHAPES = 50;

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** A new shape from two corners of a drag (any direction). Null when it is too small to be a shape. */
export function fromDrag(type: ShapeType, x0: number, y0: number, x1: number, y1: number): Shape | null {
  const left = clamp01(Math.min(x0, x1)), right = clamp01(Math.max(x0, x1));
  const top = clamp01(Math.min(y0, y1)), bottom = clamp01(Math.max(y0, y1));
  if (right - left < MIN_SIZE || bottom - top < MIN_SIZE) return null;
  return { type, x: left, y: top, w: right - left, h: bottom - top };
}

/** Move a brush stroke; all its points stay inside the picture. */
export function moveBrush(s: Shape, dx: number, dy: number): Shape {
  const pts = s.pts ?? [];
  if (!pts.length) return s;
  const minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0]));
  const minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  const ddx = Math.min(1 - maxX, Math.max(-minX, dx)), ddy = Math.min(1 - maxY, Math.max(-minY, dy));
  return { ...s, pts: pts.map(p => [p[0] + ddx, p[1] + ddy] as [number, number]) };
}

/** Move a shape; it stays inside the picture (it is not squeezed). */
export function move(s: Shape, dx: number, dy: number): Shape {
  if (s.type === 'brush') return moveBrush(s, dx, dy);
  const x = Math.min(1 - s.w, Math.max(0, s.x + dx));
  const y = Math.min(1 - s.h, Math.max(0, s.y + dy));
  return { ...s, x, y };
}

/**
 * Resize by dragging a handle by (dx, dy). Dragging an edge past the opposite one flips the shape (as in any drawing program);
 * the result stays inside the picture and is never smaller than MIN_SIZE (the fixed edge stays where it is).
 */
export function resize(s: Shape, handle: Handle, dx: number, dy: number): Shape {
  let left = s.x, top = s.y, right = s.x + s.w, bottom = s.y + s.h;
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;
  const fixX = handle.includes('w') ? s.x + s.w : handle.includes('e') ? s.x : null;   // the edge that does not move
  const fixY = handle.includes('n') ? s.y + s.h : handle.includes('s') ? s.y : null;
  const fit = (a: number, b: number, fixed: number): [number, number] => {
    let lo = clamp01(Math.min(a, b)), hi = clamp01(Math.max(a, b));
    if (hi - lo < MIN_SIZE) {
      // grow away from the fixed edge, towards the side the pointer is on
      const dir = (a === fixed ? b : a) >= fixed ? 1 : -1;
      lo = dir > 0 ? fixed : fixed - MIN_SIZE;
      hi = dir > 0 ? fixed + MIN_SIZE : fixed;
      if (hi > 1) { hi = 1; lo = 1 - MIN_SIZE; }
      if (lo < 0) { lo = 0; hi = MIN_SIZE; }
    }
    return [lo, hi];
  };
  const out = { ...s };   // an axis the handle does not touch is kept exactly as it was
  if (fixX !== null) { [left, right] = fit(left, right, fixX); out.x = left; out.w = right - left; }
  if (fixY !== null) { [top, bottom] = fit(top, bottom, fixY); out.y = top; out.h = bottom - top; }
  return out;
}

/** Keyboard nudge: like move, by shares of the picture. */
export const nudge = move;

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The distance of a point to a brush stroke, in units of the WIDTH of the picture (aspect = width / height, so that the brush is round). */
export function brushDistance(s: Shape, px: number, py: number, aspect = 1): number {
  const pts = s.pts ?? [];
  if (!pts.length) return Infinity;
  const k = 1 / aspect;   // a step of 1 in y is k widths
  let best = Infinity;
  if (pts.length === 1) return Math.hypot(px - pts[0][0], (py - pts[0][1]) * k);
  for (let i = 0; i < pts.length - 1; i++) {
    best = Math.min(best, distToSegment(px, py * k, pts[i][0], pts[i][1] * k, pts[i + 1][0], pts[i + 1][1] * k));
  }
  return best;
}

/** Is the point (px, py) on the shape? An ellipse only inside the ellipse, not in the corners of its box; a brush stroke within the radius of the brush. */
export function contains(s: Shape, px: number, py: number, aspect = 1): boolean {
  if (s.type === 'brush') return brushDistance(s, px, py, aspect) <= (s.r ?? 0);
  if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) return false;
  if (s.type === 'rect') return true;
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  const nx = (px - cx) / (s.w / 2), ny = (py - cy) / (s.h / 2);
  return nx * nx + ny * ny <= 1;
}

/** The shape on top at the point (the last one drawn), or -1. */
export function hit(shapes: Shape[], px: number, py: number, aspect = 1): number {
  for (let i = shapes.length - 1; i >= 0; i--) if (contains(shapes[i], px, py, aspect)) return i;
  return -1;
}

export function sameShapes(a: Shape[], b: Shape[]): boolean {
  return a.length === b.length && a.every((s, i) => s.type === b[i].type && s.x === b[i].x && s.y === b[i].y && s.w === b[i].w && s.h === b[i].h
    && s.r === b[i].r && JSON.stringify(s.pts ?? null) === JSON.stringify(b[i].pts ?? null));
}

/**
 * Fewer points for a stroke (Ramer-Douglas-Peucker): a hand makes hundreds of points a second, a few dozen show the same line. `eps` is in units of
 * the width of the picture. The first and the last point stay; a stroke never ends up with more than MAX_BRUSH_POINTS (the tolerance is raised until it fits).
 */
export function simplifyStroke(pts: [number, number][], eps: number, aspect = 1): [number, number][] {
  if (pts.length <= 2) return pts.slice();
  const k = 1 / aspect;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i][0], pts[i][1] * k, pts[a][0], pts[a][1] * k, pts[b][0], pts[b][1] * k);
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > eps && wi > 0) { keep[wi] = true; stack.push([a, wi], [wi, b]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  return out.length > MAX_BRUSH_POINTS ? simplifyStroke(pts, eps * 2, aspect) : out;
}

/** What is sent to the server. */
export function toRequest(shapes: Shape[]): Shape[] {
  return shapes.map(s => (s.type === 'brush'
    ? { type: s.type, x: 0, y: 0, w: 0, h: 0, r: round6(s.r ?? 0), pts: (s.pts ?? []).map(p => [round6(p[0]), round6(p[1])] as [number, number]) }
    : { type: s.type, x: round6(s.x), y: round6(s.y), w: round6(s.w), h: round6(s.h) }));
}

/** Shapes from the server, made safe to edit (a broken entry is dropped, not edited). */
export function fromServer(list: unknown): Shape[] {
  if (!Array.isArray(list)) return [];
  const out: Shape[] = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const s = it as Partial<Shape>;
    if (s.type === 'brush') {   // a stroke: a sane radius and at least one point
      const r = s.r;
      const pts = Array.isArray(s.pts) ? s.pts.filter(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v))) : [];
      if (typeof r === 'number' && Number.isFinite(r) && r >= MIN_BRUSH_R && r <= MAX_BRUSH_R && pts.length) {
        out.push({ type: 'brush', x: 0, y: 0, w: 0, h: 0, r, pts: pts.slice(0, MAX_BRUSH_POINTS).map(p => [clamp01(p[0]), clamp01(p[1])] as [number, number]) });
      }
      continue;
    }
    if ((s.type !== 'rect' && s.type !== 'ellipse') || ![s.x, s.y, s.w, s.h].every(v => typeof v === 'number' && Number.isFinite(v))) continue;
    const left = clamp01(s.x!), top = clamp01(s.y!), right = clamp01(s.x! + s.w!), bottom = clamp01(s.y! + s.h!);
    if (right - left > 0 && bottom - top > 0) out.push({ type: s.type, x: left, y: top, w: right - left, h: bottom - top });
  }
  return out.slice(0, MAX_SHAPES);
}

/** Undo / redo over snapshots of the whole list of shapes. */
export class History {
  private past: Shape[][] = [];
  private future: Shape[][] = [];
  private present: Shape[];
  private limit: number;

  constructor(present: Shape[], limit = 100) {
    this.present = present;
    this.limit = limit;
  }

  get current(): Shape[] { return this.present; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  /** Record a new state (call when a change is finished, not on every pointer move). A state equal to the current one is ignored. */
  push(next: Shape[]) {
    if (sameShapes(this.present, next)) return;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
    this.future = [];
  }

  undo(): Shape[] {
    const prev = this.past.pop();
    if (prev) { this.future.push(this.present); this.present = prev; }
    return this.present;
  }

  redo(): Shape[] {
    const next = this.future.pop();
    if (next) { this.past.push(this.present); this.present = next; }
    return this.present;
  }
}
