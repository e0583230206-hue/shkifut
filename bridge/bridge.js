// WhatsApp group -> channel bridge (WAHA webhook -> channel import API)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const E = process.env;
const PORT = 8080;
const WAHA = E.WAHA_URL || 'http://waha:3000';
const WAHA_KEY = E.WAHA_API_KEY || '';
const CHANNEL_URL = E.CHANNEL_IMPORT_URL;
const CHANNEL_KEY = E.CHANNEL_API_KEY;
const GROUP_IDS = (E.GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED = (E.ALLOWED_SENDERS || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
const MEDIA_DIR = E.MEDIA_DIR || '/media';
const MEDIA_BASE = (E.MEDIA_BASE_URL || '').replace(/\/$/, '');
const UPLOAD_URL = E.CHANNEL_UPLOAD_URL || '';

const GCHAT = E.GCHAT_WEBHOOK || "";
async function postToGChat(text) {
  if (!GCHAT) return;
  try {
    const r = await fetch(GCHAT, { method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ text }) });
    if (!r.ok) log("gchat failed", r.status, (await r.text()).slice(0, 200)); else log("gchat posted");
  } catch (e) { log("gchat error", e.message); }
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const seen = new Set();
const { makeChatSender } = require('./chat-sender.js');
const chat = makeChatSender({ fetch, env: E, log });
const { checkNotifyRequest } = require('./notify-guard.js');
const NOTIFY_KEY = E.NOTIFY_KEY || ''; // POST /notify from the site; without a key the endpoint is off

function waToMd(t) {
  return (t || '')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:]|$)/g, '$1**$2**')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:]|$)/g, '$1*$2*')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:]|$)/g, '$1~~$2~~');
}

// --- BEGIN uploadToChannel (media goes to the channel's own upload endpoint: it is checked and blurred there)
async function uploadToChannel(buf, name, mime, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'application/octet-stream' }), name);
  const r = await fetch(UPLOAD_URL, { method: 'POST', headers: { 'X-API-Key': CHANNEL_KEY }, body: fd });
  if (!r.ok) throw new Error('channel upload ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  if (out.filetype === 'image') return `[image-embedded#](${out.url})`;
  if (out.filetype === 'video') return `[video-embedded#](${out.url})`;
  if (out.filetype === 'audio') return `[audio-embedded#](${out.url})`;
  return `[${filename || 'קובץ'}](${out.url})`;
}
// --- END uploadToChannel

// Downloads the media from WAHA once: the original goes to the private Chat space, the site gets its own upload.
async function fetchMedia(media) {
  if (!media || !media.url) return null;
  const url = media.url.replace(/^https?:\/\/[^/]+/, WAHA);
  const r = await fetch(url, { headers: { 'X-Api-Key': WAHA_KEY } });
  if (!r.ok) throw new Error('media download ' + r.status);
  const mime = (media.mimetype || r.headers.get('content-type') || '').split(';')[0].trim();
  const ext = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  return { buf: Buffer.from(await r.arrayBuffer()), mime, name, filename: media.filename || name };
}

// The site: uploaded through the channel's own endpoint (checked and blurred there), or served by this bridge (old way).
async function mediaToEmbed(m) {
  if (UPLOAD_URL) return await uploadToChannel(m.buf, m.name, m.mime, m.filename);
  if (!MEDIA_BASE) return null;
  fs.writeFileSync(path.join(MEDIA_DIR, m.name), m.buf);
  const link = MEDIA_BASE + '/media/' + m.name;
  if (m.mime.startsWith('image/')) return `[image-embedded#](${link})`;
  if (m.mime.startsWith('video/')) return `[video-embedded#](${link})`;
  if (m.mime.startsWith('audio/')) return `[audio-embedded#](${link})`;
  return `[${m.filename || 'קובץ'}](${link})`;
}

// The private Chat space: original media + caption as an attachment (as the authorised user). Text-only messages and
// failures go by the webhook, as plain text (never a link to the site).
let lastAuthAlert = 0;
function alertAuth() {
  if (Date.now() - lastAuthAlert < 6 * 3600 * 1000) return;
  lastAuthAlert = Date.now();
  postToGChat('⚠️ ההרשאה לשליחת מדיה לצ׳אט פגה או בוטלה. צריך להתחבר מחדש (chat_oauth.py). עד אז תמונות וסרטונים לא יישלחו לכאן.');
}
async function sendToSpace(p, media) {
  const caption = (p.body || '').trim();
  if (media && chat.enabled) {
    try {
      await chat.sendMedia({ buf: media.buf, mime: media.mime, filename: media.filename, caption });
      log('chat posted (original media)', p.id);
      return;
    } catch (e) {
      log('chat media failed:', e.message);
      if (e.authFailed) alertAuth();
    }
    postToGChat((caption ? caption + '\n' : '') + '[קובץ מדיה לא הועלה לצ׳אט - ראה את הלוג של הגשר]');
    return;
  }
  if (caption) postToGChat(caption);
}

async function postToChannel(text) {
  const r = await fetch(CHANNEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': CHANNEL_KEY },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error('channel ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

async function handle(ev) {
  if (!ev || !String(ev.event).startsWith('message')) return;
  const p = ev.payload || {};
  if (p.id && seen.has(p.id)) return;
  if (p.id) { seen.add(p.id); if (seen.size > 5000) seen.clear(); }
  const chat = p.fromMe ? p.to : p.from;
  if (!chat || !chat.endsWith('@g.us')) return;
  if (!GROUP_IDS.length) { log('GROUP FOUND (set GROUP_IDS):', chat, '| text:', (p.body || '').slice(0, 40)); return; }
  if (!GROUP_IDS.includes(chat)) return;
  const sender = String(p.participant || (p._data && p._data.Info && p._data.Info.Sender) || p.author || '').replace(/\D/g, '');
  if (ALLOWED.length && !p.fromMe && !ALLOWED.some(a => sender.startsWith(a) || a.startsWith(sender))) {
    log('skipped sender', sender); return;
  }
  const parts = [];
  let media = null; // the original file (for the private Chat space)
  if (p.hasMedia) {
    try { media = await fetchMedia(p.media); } catch (e) { log('media error', e.message); }
    if (!media) log('media without url (WAHA could not provide the file)', p.id);
    else {
      try { const emb = await mediaToEmbed(media); if (emb) parts.push(emb); }
      catch (e) { log('site media upload error', e.message); }
    }
  }
  if (p.body) parts.push(waToMd(p.body));
  if (!parts.length && !media) return;
  sendToSpace(p, media).catch(e => log('chat error', e.message)); // independent of the site post below
  if (!CHANNEL_URL || !parts.length) return;
  for (let i = 1; i <= 3; i++) {
    try { await postToChannel(parts.join('\n')); log('posted', p.id); return; }
    catch (e) { log('post failed try', i, e.message); await new Promise(r => setTimeout(r, 3000 * i)); }
  }
}

async function health() {
  try {
    const r = await fetch(WAHA + '/api/sessions/default', { headers: { 'X-Api-Key': WAHA_KEY } });
    const s = await r.json();
    if (s.status !== 'WORKING') log('WARNING: WhatsApp session status =', s.status, '- rescan QR in dashboard');
  } catch (e) { log('WARNING: WAHA unreachable', e.message); }
  try {
    const st = fs.statfsSync(MEDIA_DIR);
    const free = st.bavail / st.blocks;
    if (free < 0.1) log('WARNING: disk almost full,', Math.round(free * 100) + '% free');
  } catch {}
}
setInterval(health, 10 * 60 * 1000); setTimeout(health, 30000);
log('chat: ' + (chat.enabled ? 'ENABLED (original media -> ' + chat.space + ')' : 'disabled (no credentials)'));
setInterval(() => chat.keepAlive(), 24 * 3600 * 1000); setTimeout(() => chat.keepAlive(), 60000);

fs.mkdirSync(MEDIA_DIR, { recursive: true });
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => {
      res.end('ok');
      let ev; try { ev = JSON.parse(b); } catch { return; }
      handle(ev).catch(e => log('handle error', e.message));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/notify') {
    // The site tells the private space that a video waits for approval (text only). Internal network + key only.
    const g = checkNotifyRequest(req, NOTIFY_KEY);
    if (!g.ok) { res.statusCode = g.status; return res.end(); }
    let b = '';
    req.on('data', c => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let text; try { text = JSON.parse(b).text; } catch {}
      if (typeof text !== 'string' || !text.trim() || text.length > 1500) { res.statusCode = 400; return res.end(); }
      if (!GCHAT) { res.statusCode = 503; return res.end(); }
      await postToGChat(text);
      res.end('ok');
    });
    return;
  }
  const m = req.url.match(/^\/media\/([a-f0-9]{24}\.[a-z0-9]+)$/i);
  if (req.method === 'GET' && m) {
    const f = path.join(MEDIA_DIR, m[1]);
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
    const types = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', ogg: 'audio/ogg', mpeg: 'audio/mpeg', pdf: 'application/pdf' };
    res.setHeader('Content-Type', types[f.split('.').pop()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    return fs.createReadStream(f).pipe(res);
  }
  if (req.url === '/health') return res.end('ok');
  res.statusCode = 404; res.end();
}).listen(PORT, () => log('bridge listening on', PORT, '| groups:', GROUP_IDS.join(',') || '(discovery mode)'));
