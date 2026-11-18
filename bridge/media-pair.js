// The same media sent twice by WhatsApp in two qualities (a standard version and, seconds or minutes later, an HD one) must reach the
// site once. Seen 12-14.11.2026: the same caption, an image 1920x1080 then 3840x2160; a video 854x480 then 1280x720 (the second one
// arrived up to 31 minutes later). The bridge got two WhatsApp messages with two ids and published both. It happens for the
// distribution bot and for the organizers alike, so the rule is not tied to one sender.
//
// How it works: the FIRST media message is published at once (no waiting). A later one from the same sender with the same kind of
// media and the same caption, within PAIR_WINDOW_MS (default 60 minutes) and with the same picture shape (width/height ratio, when
// WhatsApp tells it), is the other quality of the same media and is not published. A message without a caption is never paired
// (two different pictures of an album can look alike without it).
// PAIR_SENDERS: '*' = every sender; a list of numbers = only them; empty = off (nothing changes).

const MIN_CAPTION = 5; // characters of the caption (after clean-up) needed to pair
const RATIO_TOLERANCE = 0.03; // 3%: the two qualities of one media keep the same shape

const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

function parseSenders(s) {
  return String(s || '').split(',').map((x) => (x.trim() === '*' ? '*' : x.replace(/\D/g, ''))).filter(Boolean);
}

function kindOf(p) {
  const mt = String((p.media && p.media.mimetype) || p.mimetype || '').toLowerCase();
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('image/')) return 'image';
  return mt ? 'other' : 'media';
}

function dims(p) {
  const m = (p && p._data && p._data.Message) || {};
  const x = m.imageMessage || m.videoMessage || m.documentMessage || {};
  return { w: Number(x.width) || 0, h: Number(x.height) || 0 };
}

// width / height, or 0 when WhatsApp did not say
function ratioOf(p) {
  const { w, h } = dims(p);
  return w > 0 && h > 0 ? w / h : 0;
}

function sameShape(a, b) {
  if (!a || !b) return true; // unknown shape: the caption and the time decide
  return Math.abs(a - b) / Math.max(a, b) <= RATIO_TOLERANCE;
}

// A number that grows with the quality: pixels when WhatsApp says them, else the size of the file, else 0 (kept for the logs/tests).
function quality(p) {
  const m = (p && p._data && p._data.Message) || {};
  const x = m.imageMessage || m.videoMessage || m.documentMessage || {};
  const pixels = (Number(x.width) || 0) * (Number(x.height) || 0);
  if (pixels > 0) return pixels;
  return Number(x.fileLength) || Number(p && p.media && p.media.fileLength) || 0;
}

function createPairer({ senders = [], windowMs = 3600000, now = Date.now } = {}) {
  const seen = new Map(); // key -> [{ t, ratio, ev }]
  const all = senders.includes('*');
  const prune = (t) => {
    for (const [k, list] of seen) {
      const keep = list.filter((e) => t - e.t <= windowMs);
      if (keep.length) seen.set(k, keep); else seen.delete(k);
    }
  };
  return {
    // '' = this message is not paired (feature off, other sender, no caption)
    keyOf(p, sender) {
      if (!senders.length || !(windowMs > 0) || !(all || senders.includes(sender))) return '';
      const caption = norm(p && p.body);
      if (caption.length < MIN_CAPTION) return '';
      return [sender, kindOf(p), caption].join('|');
    },
    // Resolves to the event that is published for this media: p itself when it is the first one, else the earlier one (then p is skipped).
    async hold(key, p) {
      const t = now();
      prune(t);
      const ratio = ratioOf(p);
      const list = seen.get(key) || [];
      const earlier = list.find((e) => sameShape(e.ratio, ratio));
      if (earlier) return earlier.ev;
      list.push({ t, ratio, ev: p });
      seen.set(key, list);
      return p;
    },
    size() { return seen.size; },
  };
}

module.exports = { createPairer, parseSenders, quality, kindOf, ratioOf, sameShape, MIN_CAPTION };
