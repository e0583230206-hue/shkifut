// Replies: a WhatsApp reply carries the id of the message it answers, but the bridge used to drop it, so the site showed the answer without
// its context (about a quarter of the messages of the group are replies). Here the bridge remembers which site message each WhatsApp message
// became, and a reply gets the site's own quote line in front of its text:   [quote-embedded#](<site message number>@<short text>)
//
// Only a message that is ALREADY on the site is quoted. A reply to a message that was not published (another sender, an older message, a failed
// post) gets no quote at all, so the text of a message the bridge decided not to publish never reaches the site through a reply.
// Never the media of the quoted message: only its text (or the word "מדיה"), so a quote cannot get around the blurring.
const fs = require('fs');
const path = require('path');

// WhatsApp ids: the full one of a message is  false_<group>_<STANZA>_<participant>  and a reply names the quoted message by <STANZA> alone.
function stanzaId(id) {
  const s = String(id == null ? '' : id).trim();
  const parts = s.split('_');
  return parts.length >= 4 ? parts[2] : s;
}

// A short, safe text for the quote line: no markup of WhatsApp or of the site, no brackets (they end the quote syntax), no HTML, one line.
function snippetOf(body, hasMedia, max = 80) {
  let t = String(body == null ? '' : body)
    .replace(/\[[a-z]+-embedded#\]\([^)]*\)/gi, ' ')      // embeds of the site
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩︎️﻿]/g, '')   // invisible marks
    .replace(/[*_~`#>|\\@<>&"'()[\]{}]/g, ' ')            // markup, HTML, brackets, "@" (the separator of the quote syntax)
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return hasMedia ? 'מדיה' : '';
  if ([...t].length > max) t = [...t].slice(0, max - 1).join('').trim() + '…';
  return t;
}

function quoteLine(siteId, snippet) {
  return `[quote-embedded#](${Number(siteId)}@${snippet})`;
}

// WhatsApp id (stanza) -> site message number, kept in a small JSON file (it must survive a restart of the bridge: a reply to a message of
// yesterday still has to find it, and a message that WhatsApp delivers again after a reconnect must not be posted twice).
function createStore(file, { max = 5000, fsImpl = fs } = {}) {
  let map = new Map();
  try {
    const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') map = new Map(Object.entries(raw).filter(([k, v]) => k && Number.isInteger(v) && v > 0));
  } catch { /* no file yet, or an unreadable one: start empty */ }

  function save() {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fsImpl.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
      fsImpl.renameSync(tmp, file);
    } catch { /* a read-only disk must not stop the bridge from posting */ }
  }

  return {
    has: (stanza) => map.has(stanza),
    get: (stanza) => map.get(stanza),
    size: () => map.size,
    set(stanza, siteId) {
      if (!stanza || !Number.isInteger(siteId) || siteId <= 0) return;
      map.delete(stanza);                   // a repeated id moves to the newest place
      map.set(stanza, siteId);
      while (map.size > max) map.delete(map.keys().next().value);   // the oldest go first
      save();
    },
  };
}

module.exports = { stanzaId, snippetOf, quoteLine, createStore };
