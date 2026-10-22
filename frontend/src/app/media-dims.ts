/**
 * The server appends the display size to the address of an uploaded file ("/api/files/<id>.jpg?w=848&h=480"), so the page can reserve the right
 * box before the file has loaded. Older messages have no size: they get a default box that is corrected when the file has loaded.
 */
export interface MediaDims { w: number; h: number; }

export function dimsFromUrl(url: string): MediaDims | null {
  const m = /[?&]w=(\d{1,5})&h=(\d{1,5})/.exec(url);
  if (!m) return null;
  const w = +m[1], h = +m[2];
  return w > 0 && h > 0 ? { w, h } : null;
}

/** CSS aspect-ratio of the box for a picture or a video; `known` is false for the default. */
export function boxRatio(dims: MediaDims | null, kind: 'image' | 'video'): { css: string; known: boolean } {
  if (dims) return { css: `${dims.w} / ${dims.h}`, known: true };
  return { css: kind === 'video' ? '16 / 9' : '4 / 3', known: false };
}
