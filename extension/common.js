// Shared by the background worker and the side panel.
// Text only: no images or videos are fetched or shown here (privacy: blurring happens on the site).
export const DEFAULT_BASE = 'https://hashkifut.co.il';

export async function getBase() {
  const { base } = await chrome.storage.local.get('base');
  return (base || DEFAULT_BASE).replace(/\/+$/, '');
}

// Returns { ok, status, messages }. 401 = not signed in on the site.
// `raw` is how many messages the server returned before our filtering. `offset` is a bookmark, not a count:
// the id of the last message of the previous page (`last`), and the server pages after it (0 = from the newest).
// `poll` marks a background check (nobody is looking): the site then counts no view and no "online" for it.
export async function fetchMessages(limit = 20, offset = 0, poll = false) {
  const base = await getBase();
  try {
    const res = await fetch(`${base}/api/messages?limit=${limit}&offset=${offset}${poll ? '&poll=1' : ''}&t=${Date.now()}`, { credentials: 'include' });
    if (!res.ok) return { ok: false, status: res.status, messages: [], raw: 0, last: 0 };
    const data = await res.json();
    const all = Array.isArray(data) ? data : [];
    const messages = all
      .filter((m) => m && !m.deleted && !m.held && !m.is_ads)
      .sort((a, b) => b.id - a.id);
    const last = all.length ? all[all.length - 1].id : 0; // the server sends newest first, by time
    return { ok: true, status: 200, messages, raw: all.length, last };
  } catch (e) {
    return { ok: false, status: 0, messages: [], raw: 0, last: 0 };
  }
}

// Report a message to the site's moderators (saved for review on the site; needs a signed-in reader).
export async function sendReport(messageId, reason) {
  const base = await getBase();
  try {
    const res = await fetch(`${base}/api/messages/report`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, reason }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0 };
  }
}

// Channel name and logo (shown in the header of every message).
let infoCache = null;
export async function fetchChannelInfo() {
  if (infoCache) return infoCache;
  const base = await getBase();
  try {
    const res = await fetch(`${base}/api/channel/info?t=${Date.now()}`, { credentials: 'include' });
    if (res.ok) {
      const c = await res.json();
      infoCache = { name: c.name || 'שקיפות', logoUrl: c.logoUrl || '', contact: c.contact_us || '' };
      return infoCache;
    }
  } catch (e) { /* fall through */ }
  return { name: 'שקיפות', logoUrl: '', contact: '' };
}

// The logo can be a site file or any picture address; it is fetched here and shown as a local blob.
export async function loadLogo(logoUrl) {
  if (!logoUrl) return null;
  const base = await getBase();
  if (/^\/api\/files\/[0-9a-f]{40}/.test(logoUrl)) return loadMedia(logoUrl.match(/^\/api\/files\/[0-9a-f]{40}/)[0]);
  const url = /^https?:/.test(logoUrl) ? logoUrl : base + (logoUrl.startsWith('/') ? '' : '/') + logoUrl;
  const key = 'logo:' + url;
  if (blobCache.has(key)) return blobCache.get(key);
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('logo');
  const b = URL.createObjectURL(await res.blob());
  blobCache.set(key, b);
  return b;
}

// Reactions: the site's own list of allowed emojis, and the same POST the site uses (needs a signed-in reader).
let emojiCache = null;
export async function fetchEmojis() {
  if (emojiCache) return emojiCache;
  const base = await getBase();
  try {
    const res = await fetch(`${base}/api/emojis/list`, { credentials: 'include' });
    if (res.ok) { const l = await res.json(); if (Array.isArray(l)) emojiCache = l; }
  } catch (e) { /* none */ }
  return emojiCache || [];
}

export async function sendReaction(messageId, emoji) {
  const base = await getBase();
  try {
    const res = await fetch(`${base}/api/reactions/set-reactions`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, emoji }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0 };
  }
}

export async function fetchMessage(id) {
  const base = await getBase();
  try {
    const res = await fetch(`${base}/api/messages/${id}?t=${Date.now()}`, { credentials: 'include' });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

// Pinned messages: [{ id, snippet, ... }]. Text only.
export async function fetchPinned() {
  const base = await getBase();
  try {
    const res = await fetch(`${base}/api/messages/pinned?t=${Date.now()}`, { credentials: 'include' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// Media of a message: [{ kind: 'image' | 'video', path: '/api/files/<id>' }]. It sits in the text as
// "[image-embedded#](/api/files/<id>)" (a gallery holds several ids) and sometimes in m.file.
export function extractMedia(m) {
  const out = [];
  const seen = new Set();
  const add = (kind, path) => {
    if (!/^\/api\/files\/[0-9a-f]{40}/.test(path)) return;
    const p = path.match(/^\/api\/files\/[0-9a-f]{40}/)[0];
    if (seen.has(p)) return;
    seen.add(p);
    out.push({ kind, path: p });
  };
  for (const hit of String(m.text || '').matchAll(/\[(image|video|gallery)-embedded#\]\(([^)]*)\)/g)) {
    for (const p of hit[2].match(/\/api\/files\/[0-9a-f]{40}/g) || []) add(hit[1] === 'video' ? 'video' : 'image', p);
  }
  const ft = m.file && m.file.filetype;
  if (m.file && m.file.url && (ft === 'image' || ft === 'video')) add(ft, m.file.url);
  return out;
}

// Media is always fetched with ?view=public: the server then returns what an ordinary reader gets
// (blurred, or a "waiting for approval" frame), even when the signed-in account is an owner or approver.
// It is fetched here and shown as a local blob, so the browser never loads the original by itself.
const blobCache = new Map();
export async function loadMedia(path) {
  const base = await getBase();
  const key = base + path;
  if (blobCache.has(key)) return blobCache.get(key);
  const res = await fetch(`${base}${path}?view=public`, { credentials: 'include' });
  if (!res.ok) { const e = new Error('media'); e.status = res.status; throw e; }
  const url = URL.createObjectURL(await res.blob());
  blobCache.set(key, url);
  return url;
}

// Like plain(), but keeps the paragraphs (for showing a message in the window).
export function rich(text, max = 5000) {
  const t = String(text || '')
    .replace(/\[(?:image|video|audio|gallery|quote)-embedded#\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[ 	]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function plain(text, max = 200) {
  // Drop markdown embeds (images/videos/files), keep link text; media is never shown here.
  const t = String(text || '')
    .replace(/\[(?:image|video|audio|gallery|quote)-embedded#\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export async function messageUrl(id) {
  return `${await getBase()}/m/${id}`;
}
