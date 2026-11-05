// Which site messages belong to WhatsApp messages that were deleted there (the sender deleted a message and sent it again, and the first one stayed on the
// site). The bridge asks WAHA for the latest messages of the group, and a message it posted that is no longer among them is a candidate.
//
// The rules are strict, because a wrong deletion removes a real news item from the site:
//  * only the latest `recent` messages the bridge posted are looked at;
//  * the history has to prove that it reaches back far enough: a message is judged only when a message POSTED BEFORE IT is still in the history
//    (otherwise it may simply be older than the window WAHA returned);
//  * an empty history, or one where none of the recent messages is present, is treated as a failure of WAHA and nothing is judged;
//  * a message must be missing in `confirmations` cycles in a row before it is deleted;
//  * at most `maxPerCycle` deletions in one cycle.

/**
 * @param {{entries: Array<[string, number]>, present: Set<string>, pending: Map<string, number>, recent?: number, confirmations?: number, maxPerCycle?: number}} p
 *   entries: [WhatsApp message id (stanza), site message number] of what the bridge posted; present: the ids in the history of the group;
 *   pending: how many cycles in a row each message has been missing so far.
 * @returns {{gone: Array<[string, number]>, pending: Map<string, number>, judged: boolean}}
 */
function findGone({ entries, present, pending, recent = 80, confirmations = 2, maxPerCycle = 3 }) {
  const keep = new Map(pending);
  if (!present || present.size === 0) return { gone: [], pending: keep, judged: false };

  const latest = [...entries].sort((a, b) => b[1] - a[1]).slice(0, recent);
  const presentOnes = latest.filter(([stanza]) => present.has(stanza));
  if (presentOnes.length === 0) return { gone: [], pending: keep, judged: false };

  // The oldest of the recent messages that is still in the history: what was posted after it is inside the window of the history.
  const anchor = Math.min(...presentOnes.map(([, id]) => id));
  const next = new Map();
  const due = [];
  for (const [stanza, siteId] of latest) {
    if (present.has(stanza) || siteId <= anchor) continue;
    const count = (pending.get(stanza) || 0) + 1;
    next.set(stanza, count);
    if (count >= confirmations) due.push([stanza, siteId]);
  }
  due.sort((a, b) => a[1] - b[1]);
  return { gone: due.slice(0, maxPerCycle), pending: next, judged: true };
}

module.exports = { findGone };
