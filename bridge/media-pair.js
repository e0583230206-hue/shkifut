// One media sent twice in two qualities (a standard version and, seconds later, an HD one) must reach the site once.
// Seen on 12.11.2026 from the distribution bot: the same caption, an image 1920x1080 and 3 seconds later 3840x2160; a video 854x480 and
// less than a second later 1280x720. The bridge got two WhatsApp messages with two ids and published both.
//
// How it works: for the senders named in PAIR_SENDERS, a message with media and a caption waits PAIR_WINDOW_MS. A message of the same
// sender with the same kind of media and the same caption that arrives meanwhile joins the wait. At the end ONE message is kept: the one with
// the larger picture (width x height from WhatsApp's own data), else the larger file, else the later one. The others are not published.
// Off by default (no PAIR_SENDERS): nothing changes. A media message without a caption is never paired (two different pictures of an album
// can look alike without it).

const MIN_CAPTION = 5; // characters of the caption (after clean-up) needed to pair

const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

function parseSenders(s) {
  return String(s || '').split(',').map((x) => x.replace(/\D/g, '')).filter(Boolean);
}

function kindOf(p) {
  const mt = String((p.media && p.media.mimetype) || p.mimetype || '').toLowerCase();
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('image/')) return 'image';
  return mt ? 'other' : 'media';
}

// A number that grows with the quality: pixels when WhatsApp says them, else the size of the file, else 0.
function quality(p) {
  const m = (p && p._data && p._data.Message) || {};
  const x = m.imageMessage || m.videoMessage || m.documentMessage || {};
  const pixels = (Number(x.width) || 0) * (Number(x.height) || 0);
  if (pixels > 0) return pixels;
  return Number(x.fileLength) || Number(p && p.media && p.media.fileLength) || 0;
}

function pick(events) {
  let best = events[0];
  let bq = quality(best);
  for (const e of events.slice(1)) {
    const q = quality(e);
    if (q >= bq) { best = e; bq = q; } // equal: the later one (the HD version came second every time)
  }
  return best;
}

function createPairer({ senders = [], windowMs = 30000, setTimer = setTimeout } = {}) {
  const pending = new Map();
  return {
    // '' = this message is not paired (feature off, other sender, no caption)
    keyOf(p, sender) {
      if (!senders.length || !(windowMs > 0) || !senders.includes(sender)) return '';
      const caption = norm(p && p.body);
      if (caption.length < MIN_CAPTION) return '';
      return [sender, kindOf(p), caption].join('|');
    },
    // Resolves, when the window ends, to the ONE event that is published (every caller of the same window gets the same answer).
    hold(key, p) {
      let e = pending.get(key);
      if (!e) {
        e = { events: [] };
        e.promise = new Promise((resolve) => {
          setTimer(() => { pending.delete(key); resolve(pick(e.events)); }, windowMs);
        });
        pending.set(key, e);
      }
      e.events.push(p);
      return e.promise;
    },
    size() { return pending.size; },
  };
}

module.exports = { createPairer, parseSenders, quality, pick, kindOf, MIN_CAPTION };
