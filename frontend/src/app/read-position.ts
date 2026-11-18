/** Where a returning reader left off: pure helpers (unit-tested in tests/unit/read-position.test.mjs). */

/** The oldest loaded message newer than the last one read (where the "unread" divider goes). */
export function firstUnreadId(ids: number[], lastRead: number): number | undefined {
  if (!lastRead) return undefined;
  let first: number | undefined;
  for (const id of ids) if (id > lastRead && (first === undefined || id < first)) first = id;
  return first;
}

/** How many loaded messages are newer than the last one read. */
export function unreadCount(ids: number[], lastRead: number): number {
  return lastRead ? ids.filter(id => id > lastRead).length : 0;
}

/**
 * The newest message the reader has actually seen: the highest id whose element is on screen
 * (at least partly, below the fixed header). Returns 0 if none is visible.
 */
export function newestVisibleId(items: { id: number; top: number; bottom: number }[], viewTop: number, viewBottom: number): number {
  let best = 0;
  for (const it of items) {
    const visible = it.bottom > viewTop + 8 && it.top < viewBottom - 8;
    if (visible && it.id > best) best = it.id;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Read position by TIME, with the id as tie-break (review M-read). The old helpers above compare ids only, but a message
// released from "waiting" keeps its low id and gets a new time, so id order is not the order shown. The reader's
// position is a marker: the id of the newest message seen, and its time in ms. A message is "after" the marker when its
// time is later, or the same time and a higher id. A marker saved before the time was stored has no time: then the
// id rule is used, exactly as before, until the marker's message is loaded and its time is filled in.

export interface ReadMarker { id: number; at?: number }
export interface TimedItem { id: number; at?: number }

/** Is the item after the marker (i.e. unread)? */
export function isAfterMarker(item: TimedItem, marker: ReadMarker): boolean {
  if (!marker.id) return false;
  if (marker.at === undefined || item.at === undefined || Number.isNaN(item.at)) return item.id > marker.id;
  if (item.at !== marker.at) return item.at > marker.at;
  return item.id > marker.id;
}

/** Order of two items by time, then id. Returns >0 when a is later than b. */
function laterThan(a: TimedItem, b: TimedItem): number {
  if (a.at !== undefined && b.at !== undefined && !Number.isNaN(a.at) && !Number.isNaN(b.at) && a.at !== b.at) return a.at - b.at;
  return a.id - b.id;
}

/** The oldest loaded item after the marker (where the "unread" divider goes), by time then id. */
export function firstUnreadByTime(items: TimedItem[], marker: ReadMarker): number | undefined {
  let first: TimedItem | undefined;
  for (const it of items) {
    if (!isAfterMarker(it, marker)) continue;
    if (first === undefined || laterThan(first, it) > 0) first = it;
  }
  return first?.id;
}

/** How many loaded items are after the marker. */
export function unreadCountByTime(items: TimedItem[], marker: ReadMarker): number {
  if (!marker.id) return 0;
  return items.filter(it => isAfterMarker(it, marker)).length;
}

/** The newest (by time, then id) item that is actually on screen; undefined if none is visible. */
export function newestVisibleByTime(items: (TimedItem & { top: number; bottom: number })[], viewTop: number, viewBottom: number): TimedItem | undefined {
  let best: TimedItem | undefined;
  for (const it of items) {
    const visible = it.bottom > viewTop + 8 && it.top < viewBottom - 8;
    if (visible && (best === undefined || laterThan(it, best) > 0)) best = it;
  }
  return best;
}

/** The marker after the reader has seen `item`: it moves forward only, never back. */
export function advanceMarker(marker: ReadMarker, item: TimedItem): ReadMarker {
  if (!marker.id || isAfterMarker(item, marker)) return { id: item.id, at: item.at };
  return marker;
}

/** Reads the marker from storage. Keys: 'lastReadMessage' (id) and 'lastReadMessageAt' (ms, absent before this change). */
export function readMarker(get: (key: string) => string | null): ReadMarker {
  const id = Number(get('lastReadMessage')) || 0;
  const atRaw = get('lastReadMessageAt');
  const at = atRaw === null || atRaw === '' ? undefined : Number(atRaw);
  return { id, at: at === undefined || Number.isNaN(at) ? undefined : at };
}

/** Writes the marker to storage (both keys when the time is known). */
export function writeMarker(set: (key: string, value: string) => void, marker: ReadMarker): void {
  set('lastReadMessage', String(marker.id));
  if (marker.at !== undefined) set('lastReadMessageAt', String(marker.at));
}
