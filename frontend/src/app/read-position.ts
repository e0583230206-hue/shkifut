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
