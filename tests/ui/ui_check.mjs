// Browser checks over Chrome DevTools Protocol (headless Chromium). Run with tests/ui/run_ui.sh.
// Prints PASS/FAIL lines; exits 1 on any failure. No screenshots are saved.
const BASE = process.env.BASE || 'http://backend:3000';
const MSG_ID = process.env.MSG_ID || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) failures.push(name);
};

let targets;
for (let i = 0; i < 40 && !targets; i++) {
  try { targets = await (await fetch('http://127.0.0.1:9222/json/list')).json(); } catch { await sleep(500); }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const dialogs = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  // A native alert/confirm blocks the page: record it and dismiss it.
  if (msg.method === 'Page.javascriptDialogOpening') {
    dialogs.push(`${msg.params.type}: ${msg.params.message} @ ${msg.params.url}`);
    console.log(`  (dialog ${msg.params.type}: ${msg.params.message})`);
    ws.send(JSON.stringify({ id: ++seq, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); console.log(`  (timeout: ${method})`); resolve({}); }, 15000);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const go = async (path, wait = 5000) => { await send('Page.navigate', { url: BASE + path }); await sleep(wait); };
const waitFor = async (expr, ms = 8000) => {
  for (let t = 0; t < ms; t += 250) { if (await evaluate(expr)) return true; await sleep(250); }
  return false;
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

// --- reader: home page
console.log('step: home');
await go('/', 6000);
check('home: messages rendered', await waitFor(`document.querySelectorAll('app-message').length > 0`), await evaluate(`document.querySelectorAll('app-message').length`));
check('home: contact button in header', await evaluate(`!!document.querySelector('button[title="צור קשר"]')`));
check('home: privacy / terms links', await evaluate(`!!document.querySelector('a[href="/privacy"]') && !!document.querySelector('a[href="/terms"]')`));

// ads (the runner enabled embed-code ads every 2 messages)
const feedAds = await evaluate(`[...document.querySelectorAll('.feed-ad iframe')].map(f => f.getAttribute('sandbox'))`);
check('ads: in-feed ads present', Array.isArray(feedAds) && feedAds.length > 0, feedAds?.length);
check('ads: embed code sandboxed without same-origin', (feedAds || []).every((s) => s && !s.includes('allow-same-origin')), feedAds?.[0]);
check('ads: side column shown on wide screen', await evaluate(`!!document.querySelector('.ad-column iframe')`));

// contact dialog
await evaluate(`document.querySelector('button[title="צור קשר"]').click()`);
check('contact: dialog opens with form fields', await waitFor(`!!document.querySelector('#contact-message') && !!document.querySelector('#contact-email')`));
check('contact: honeypot field is off-screen', await evaluate(`(() => { const r = document.querySelector('#contact-website')?.getBoundingClientRect(); return !!r && (r.right < 0 || r.left < -1000 || r.width <= 1); })()`));

// static pages and 404
console.log('step: static pages');
await go('/privacy', 3000);
check('privacy page renders', await waitFor(`document.querySelector('h1')?.textContent.includes('מדיניות פרטיות')`));
await go('/terms', 3000);
check('terms page renders', await waitFor(`document.querySelector('h1')?.textContent.includes('תנאי שימוש')`));
await go('/no-such-page', 3000);
check('404 page renders', await waitFor(`document.querySelector('h1')?.textContent.includes('הדף לא נמצא')`));

// shareable message address
if (MSG_ID) {
  console.log('step: /m/<id>');
  await go(`/m/${MSG_ID}`, 5000);
  check('/m/<id> opens the channel at the message', (await evaluate('location.pathname + location.hash')) === `/#${MSG_ID}`, await evaluate('location.href'));
}

// --- search: dialog, highlighted results, jump to the message
console.log('step: search');
await go('/', 5000);
const word = await evaluate(`(() => { for (const md of document.querySelectorAll('app-message markdown')) { const w = (md.innerText.match(/[א-ת]{4,}/g) || [])[0]; if (w) return w; } return ''; })()`);
check('search: picked a word from a visible message', !!word, word);
await evaluate(`document.querySelector('button[title="חיפוש"]').click()`);
check('search: dialog opens with focused input', await waitFor(`document.activeElement?.id === 'search-input'`));
await evaluate(`(() => { const i = document.querySelector('#search-input'); i.value = ${JSON.stringify(word)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
check('search: results appear with the word highlighted', await waitFor(`document.querySelectorAll('.search-result mark').length > 0`, 8000));
await evaluate(`document.querySelector('.search-result').click()`);
check('search: choosing a result closes the dialog and highlights the message',
  await waitFor(`!document.querySelector('#search-input') && !!document.querySelector('.mark_message')`, 8000));

// --- returning reader: opens at the first unread message
console.log('step: last read position');
const recent = await evaluate(`fetch('/api/messages?offset=0&limit=10&direction=desc').then(r => r.json()).then(a => a.map(m => m.id))`);
if ((recent || []).length >= 6) {
  await evaluate(`localStorage.setItem('lastReadMessage', '${recent[4]}')`); // 4 unread
  await go('/', 6000);
  check('last read: "unread" divider right before the first unread message',
    await waitFor(`document.getElementById('unread-divider')?.closest('nb-list-item')?.querySelector('app-message')?.id === '${recent[3]}'`),
    await evaluate(`document.getElementById('unread-divider')?.closest('nb-list-item')?.querySelector('app-message')?.id`));
  check('last read: the page opens at the divider (on screen)',
    await evaluate(`(() => { const r = document.getElementById('unread-divider')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.top < window.innerHeight; })()`));
  // Bring the newest message on screen (layout-agnostic: headless Chromium here lays the list out
  // top-down, real browsers bottom-up). Seen -> read.
  await evaluate(`document.getElementById('${recent[0]}')?.scrollIntoView({ block: 'center' }); window.dispatchEvent(new Event('scroll'))`);
  check('last read: seeing the newest message marks everything read', await waitFor(`localStorage.getItem('lastReadMessage') === '${recent[0]}'`, 6000),
    await evaluate(`localStorage.getItem('lastReadMessage')`));
  await evaluate(`localStorage.removeItem('lastReadMessage')`);
  await go('/', 5000);
  check('first visit: opens at the newest message without a divider',
    await waitFor(`localStorage.getItem('lastReadMessage') === '${recent[0]}' && !document.getElementById('unread-divider')`));
} else {
  check('last read: needs at least 6 messages in the channel', false, (recent || []).length);
}

// --- admin: panel tabs
console.log('step: admin');
await go('/auth/dev-login', 6000);
await evaluate(`document.querySelector('nb-user')?.click()`);
const menu = await waitFor(`[...document.querySelectorAll('.menu-title')].some(e => e.textContent.includes('ניהול ערוץ'))`, 4000);
if (menu) await evaluate(`[...document.querySelectorAll('.menu-title')].find(e => e.textContent.includes('ניהול ערוץ')).click()`);
check('admin: panel opens', await waitFor(`!!document.querySelector('admin-dashboard')`));
const titles = await evaluate(`[...document.querySelectorAll('admin-dashboard .menu-title')].map(e => e.textContent.trim())`);
check('admin: menu has ads and contact tabs', (titles || []).includes('פרסומות') && (titles || []).includes('פניות'), titles);
await evaluate(`[...document.querySelectorAll('admin-dashboard .menu-title')].find(e => e.textContent.trim() === 'פרסומות').click()`);
check('admin: ads tab renders its form', await waitFor(`!!document.querySelector('app-ads-settings #ad-code')`));
await evaluate(`[...document.querySelectorAll('admin-dashboard .menu-title')].find(e => e.textContent.trim() === 'פניות').click()`);
check('admin: contact inbox renders', await waitFor(`!!document.querySelector('app-contact-inbox nb-card')`));
await evaluate(`[...document.querySelectorAll('admin-dashboard .menu-title')].find(e => e.textContent.trim() === 'הגדרות').click()`);
check('admin: strictness level select in settings', await waitFor(`document.querySelectorAll('#moderation-level option').length === 3`));
await evaluate(`[...document.querySelectorAll('admin-dashboard .menu-title')].find(e => e.textContent.trim() === 'נושאים')?.click()`);
check('admin: topics tab renders', await waitFor(`!!document.querySelector('app-topics .add-topic')`));
await evaluate(`[...document.querySelectorAll('admin-dashboard .menu-title')].find(e => e.textContent.trim() === 'הגדרות').click()`);
check('admin: watermark section with position, size and opacity', await waitFor(`!!document.querySelector('#wm-enabled') && document.querySelectorAll('#wm-position option').length === 5 && !!document.querySelector('#wm-size') && !!document.querySelector('#wm-opacity') && !!document.querySelector('.wm-preview')`));

// --- pins and quotes (admin session): own test messages, removed at the end
console.log('step: pins & quotes');
const api = async (path, body) => evaluate(`fetch(${JSON.stringify(path)}, ${body ? `{method: 'POST', headers: {'Content-Type': 'application/json'}, body: ${JSON.stringify(JSON.stringify(body))}}` : '{}'}).then(r => r.json())`);
const pinMarker = 'ui-pin-' + Math.random().toString(36).slice(2, 8);
const pinMsg = await api('/api/admin/new', { type: 'md', text: `הודעה לנעיצה ${pinMarker}` });
const quoteMsg = await api('/api/admin/new', { type: 'md', text: `[quote-embedded#](${pinMsg?.id}@ציטוט לבדיקה)
תגובה לבדיקה ${pinMarker}` });
await api('/api/admin/pin', { id: pinMsg?.id, pinned: true });
await go('/', 6000);
check('pins: bar shows the newest pin', await waitFor(`document.querySelector('app-pinned-bar .pin-snippet')?.textContent.includes(${JSON.stringify(pinMarker)})`));
check('pins: pinned message carries the pin mark', await waitFor(`!!document.getElementById('${pinMsg?.id}')?.querySelector('.pinned-mark')`));
await evaluate(`window.scrollTo(0, 0)`);
await evaluate(`document.querySelector('app-pinned-bar .pinned-bar').click()`);
check('pins: clicking the bar highlights the pinned message', await waitFor(`document.getElementById('${pinMsg?.id}')?.classList.contains('mark_message')`));
await evaluate(`window.scrollTo(0, 0)`);
await evaluate(`document.getElementById('${quoteMsg?.id}')?.querySelector('[quote-id]')?.click()`);
check('quote: clicking a quote highlights the quoted message', await waitFor(`document.getElementById('${pinMsg?.id}')?.classList.contains('mark_message')`));
await evaluate(`document.querySelector('app-pinned-bar .pin-close')?.click()`);
check('pins: unpin from the bar removes the pin', await waitFor(`!document.getElementById('${pinMsg?.id}')?.querySelector('.pinned-mark')`));
for (const m of [pinMsg, quoteMsg]) if (m?.id) await evaluate(`fetch('/api/admin/delete-message/${m.id}')`);

// --- gallery: 5 consecutive images in one message -> 4 cells + "+1", viewer with navigation
console.log('step: gallery');
const galleryMsg = await evaluate(`(async () => {
  const urls = [];
  for (let i = 0; i < 5; i++) {
    const c = document.createElement('canvas'); c.width = 120; c.height = 90;
    const g = c.getContext('2d'); g.fillStyle = 'hsl(' + (i * 70 + Math.random() * 20) + ',70%,50%)'; g.fillRect(0, 0, 120, 90);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const fd = new FormData(); fd.append('file', blob, 'g' + i + '.png');
    urls.push((await (await fetch('/api/admin/upload', { method: 'POST', body: fd })).json()).url);
  }
  for (let t = 0; t < 60; t++) {
    const st = await Promise.all(urls.map(u => fetch('/api/files/' + u.split('/').pop().split('.')[0] + '/moderation').then(r => r.json())));
    if (st.every(s => s.status !== 'pending')) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  const text = ['גלריה לבדיקה', ...urls.map(u => '[image-embedded#](' + u + ')')].join(String.fromCharCode(10));
  return (await fetch('/api/admin/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'md', text }) })).json();
})()`);
await go('/', 6000);
const gsel = `document.getElementById('${galleryMsg?.id}')?.querySelector('.msg-gallery')`;
check('gallery: consecutive images render as one gallery', await waitFor(`!!${gsel} && ${gsel}.querySelectorAll('img').length === 5`), await evaluate(`${gsel}?.querySelectorAll('img').length`));
check('gallery: 4 visible cells and a "+1" badge', await evaluate(`${gsel}.querySelectorAll('.gallery-cell:not(.gallery-hidden)').length === 4 && ${gsel}.querySelector('.gallery-more')?.textContent.trim() === '+1'`));
await evaluate(`${gsel}.querySelector('img').click()`);
check('gallery: clicking opens a viewer over all 5 images', await waitFor(`document.querySelectorAll('.viewer-container .viewer-navbar li').length === 5`));
await evaluate(`document.querySelector('.viewer-container .viewer-next')?.click()`);
check('gallery: "next" moves to the second image', await waitFor(`[...document.querySelectorAll('.viewer-container .viewer-navbar li')].findIndex(li => li.classList.contains('viewer-active')) === 1`));
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))`);
check('composer: file picker accepts several files', await evaluate(`!!document.querySelector('app-input-form input[type=file][multiple]')`));
if (galleryMsg?.id) await evaluate(`fetch('/api/admin/delete-message/${galleryMsg.id}')`);

// --- topics: chips filter the channel, message tag, composer select (topics restored afterwards)
console.log('step: topics');
const origTopics = await evaluate(`fetch('/api/topics').then(r => r.json())`);
const tName = 'נושא-' + Math.random().toString(36).slice(2, 6);
const savedTopics = await api('/api/admin/topics', [...(origTopics || []), { name: tName, color: '#00b887' }]);
const tId = (savedTopics || []).find(t => t.name === tName)?.id;
const withTopic = await api('/api/admin/new', { type: 'md', text: `הודעה עם נושא ${tName}`, topic: tId });
const noTopic = await api('/api/admin/new', { type: 'md', text: `הודעה בלי נושא ${tName}` });
await go('/', 6000);
check('topics: chip bar shows "הכל" and the topic', await waitFor(`!!document.querySelector('app-topic-bar [data-topic="${tId}"]') && document.querySelector('app-topic-bar .topic-chip')?.textContent.trim() === 'הכל'`));
check('topics: message shows its topic tag', await waitFor(`document.getElementById('${withTopic?.id}')?.querySelector('.topic-tag')?.textContent.trim() === ${JSON.stringify(tName)}`));
await evaluate(`document.querySelector('app-topic-bar [data-topic="${tId}"]').click()`);
check('topics: choosing a topic shows only its messages', await waitFor(`!!document.getElementById('${withTopic?.id}') && !document.getElementById('${noTopic?.id}') && [...document.querySelectorAll('app-message')].every(m => m.querySelector('.topic-tag')?.textContent.trim() === ${JSON.stringify(tName)})`));
check('topics: composer defaults to the viewed topic', await waitFor(`document.querySelector('app-input-form .topic-select')?.value === '${tId}'`));
await evaluate(`document.querySelector('app-topic-bar .topic-chip').click()`);
check('topics: "הכל" shows every message again', await waitFor(`!!document.getElementById('${noTopic?.id}')`));
for (const m of [withTopic, noTopic]) if (m?.id) await evaluate(`fetch('/api/admin/delete-message/${m.id}')`);
await api('/api/admin/topics', origTopics || []);
check('topics: original topics restored', JSON.stringify(await evaluate(`fetch('/api/topics').then(r => r.json())`)) === JSON.stringify(origTopics || []));

check('no native alert/confirm dialogs appeared', dialogs.length === 0, dialogs);
ws.close();
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
