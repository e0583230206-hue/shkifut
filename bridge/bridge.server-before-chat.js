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

async function saveMedia(media) {
  if (!media || !media.url || (!MEDIA_BASE && !UPLOAD_URL)) return null;
  const url = media.url.replace(/^https?:\/\/[^/]+/, WAHA);
  const r = await fetch(url, { headers: { 'X-Api-Key': WAHA_KEY } });
  if (!r.ok) throw new Error('media download ' + r.status);
  const mime = media.mimetype || r.headers.get('content-type') || '';
  const ext = (mime.split('/')[1] || 'bin').split(';')[0].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  const buf = Buffer.from(await r.arrayBuffer());
  if (UPLOAD_URL) return await uploadToChannel(buf, name, mime, media.filename);
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  const link = MEDIA_BASE + '/media/' + name;
  if (mime.startsWith('image/')) return `[image-embedded#](${link})`;
  if (mime.startsWith('video/')) return `[video-embedded#](${link})`;
  if (mime.startsWith('audio/')) return `[audio-embedded#](${link})`;
  return `[${media.filename || 'קובץ'}](${link})`;
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
  if (p.hasMedia) {
    try {
      const emb = await saveMedia(p.media);
      if (emb) parts.push(emb); else log('media without url (WAHA Core / MEDIA_BASE_URL empty?)', p.id);
    } catch (e) { log('media error', e.message); }
  }
  if (p.body) parts.push(waToMd(p.body));
  if (!parts.length) return;
  postToGChat([p.body || "", ...parts.filter(x => x.includes("-embedded#](")).map(x => x.replace(/^\[\w+-embedded#\]\((.*)\)$/, "$1"))].filter(Boolean).join("\n"));
  if (!CHANNEL_URL) return;
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
