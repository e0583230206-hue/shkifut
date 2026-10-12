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

check('no native alert/confirm dialogs appeared', dialogs.length === 0, dialogs);
ws.close();
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
