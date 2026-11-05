// The accessibility menu, the skip link and the accessibility statement in a real Chrome (CDP, no extra packages; LOCAL stack only).
//   node tests/ui/accessibility_check.mjs [outDir] [chromePath]        (http://localhost:18080 by default; BASE_URL changes it)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localBase } from './guard.mjs';

const [outDir = '', chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
const BASE = localBase(process.env.BASE_URL);
if (outDir) mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

// a message to look at (posted by the owner through the API with the dev login, deleted again at the end)
let cookie = '';
const api = async (path, opt = {}) => {
  const r = await fetch(BASE + path, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r;
};
await api('/auth/dev-login');
const posted = await (await api('/api/admin/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'md', text: 'ידיעה לבדיקת הנגישות: טקסט רגיל שאפשר להגדיל, עם **כותרת מודגשת**.' }) })).json();
const id = posted.id;

const profile = mkdtempSync(join(tmpdir(), 'a11y-'));
const proc = spawn(chromePath, ['--remote-debugging-port=9485', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9485/json')).json(); if (targets.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let n = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { if (!outDir) return; const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); };
const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && k === 'Enter' ? { text: String.fromCharCode(13) } : {}) }); await sleep(250); };
const visible = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })()`);
const tile = (label) => `[...document.querySelectorAll('.a11y-tile')].find(e => e.innerText.includes('${label}'))`;
const click = (expr) => ev(`(${expr}).click()`);
const textSize = () => ev(`parseFloat(getComputedStyle(document.querySelector('app-message markdown') || document.querySelector('app-message')).fontSize)`);

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  for (const c of cookie.split('; ')) { const [k, ...v] = c.split('='); await send('Network.setCookie', { name: k, value: v.join('='), url: BASE }); }
  await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(6000);

  // 1. the button and the panel
  check('the accessibility button is on the page, with a name', (await visible('.a11y-trigger')) && (await ev(`document.querySelector('.a11y-trigger').getAttribute('aria-label')`)) === 'תפריט נגישות');
  await click(`document.querySelector('.a11y-trigger')`); await sleep(500);
  check('a click opens the panel (a dialog with a title)', (await visible('.a11y-panel')) && (await ev(`document.querySelector('.a11y-panel').getAttribute('role')`)) === 'dialog' && (await ev(`document.querySelector('.a11y-panel h2').innerText`)) === 'תפריט נגישות');
  check('nine choices, each with aria-pressed', (await ev(`document.querySelectorAll('.a11y-tile[aria-pressed]').length`)) === 9);
  await shot('a11y-panel.png');

  // 2. text size
  const before = await textSize();
  await click(`document.querySelector('.a11y-step[aria-label="הגדלת הטקסט"]')`); await sleep(200);
  await click(`document.querySelector('.a11y-step[aria-label="הגדלת הטקסט"]')`); await sleep(400);
  const after = await textSize();
  check('A+ twice makes the text of a message bigger (125%)', after / before > 1.2 && after / before < 1.3, `${before} -> ${after}`);
  check('the panel tells the size', (await ev(`document.querySelector('.a11y-size').innerText`)).includes('125%'));
  await click(`document.querySelector('.a11y-step[aria-label="הקטנת הטקסט"]')`); await sleep(200);
  await click(`document.querySelector('.a11y-step[aria-label="הקטנת הטקסט"]')`); await sleep(400);
  check('A− twice brings it back', Math.abs((await textSize()) - before) < 0.5);

  // 3. the choices
  await click(tile('ניגודיות גבוהה')); await sleep(200);
  check('high contrast: a contrast filter on the page, the button is pressed', (await ev(`document.documentElement.style.filter`)).includes('contrast') && (await ev(`${tile('ניגודיות גבוהה')}.getAttribute('aria-pressed')`)) === 'true');
  await click(tile('ניגודיות הפוכה')); await sleep(200);
  check('inverted colours replace high contrast (one at a time)', (await ev(`document.documentElement.style.filter`)).includes('invert') && !(await ev(`document.documentElement.style.filter`)).includes('contrast'));
  await click(tile('ניגודיות הפוכה')); await sleep(100);
  await click(tile('גווני אפור')); await sleep(200);
  check('grey scale: a grayscale filter', (await ev(`document.documentElement.style.filter`)).includes('grayscale'));
  await click(tile('גווני אפור')); await sleep(100);
  const flags = [['הדגשת קישורים', 'a11y-links'], ['הדגשת כותרות', 'a11y-headings'], ['גופן קריא', 'a11y-readable'], ['ריווח טקסט', 'a11y-spacing'], ['עצירת אנימציות', 'a11y-no-anim'], ['סמן גדול', 'a11y-cursor']];
  for (const [label, cls] of flags) {
    await click(tile(label)); await sleep(150);
    check(`"${label}": the class ${cls} is on the page`, await ev(`document.documentElement.classList.contains('${cls}')`));
  }
  check('readable font: Arial', (await ev(`getComputedStyle(document.body).fontFamily`)).includes('Arial'));
  check('links: underlined', (await ev(`getComputedStyle(document.querySelector('.legal-links a')).textDecorationLine`)) === 'underline');
  await shot('a11y-all-on.png');

  // 4. the choices are kept after a reload, and the reset clears them
  await click(`document.querySelector('.a11y-step[aria-label="הגדלת הטקסט"]')`); await sleep(200);
  const saved = await ev(`localStorage.getItem('tc-a11y')`);
  check('the choices are saved in the browser', !!saved && JSON.parse(saved).links === true && JSON.parse(saved).text === 1, saved);
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(5500);
  check('after a reload they are still on (also the text size)', (await ev(`document.documentElement.classList.contains('a11y-links') && document.documentElement.style.fontSize === '112.5%'`)));
  await click(`document.querySelector('.a11y-trigger')`); await sleep(400);
  await click(`document.querySelector('.a11y-reset')`); await sleep(400);
  check('reset: no classes, no filter, default size, nothing saved', await ev(`![...document.documentElement.classList].some(c => c.startsWith('a11y-')) && document.documentElement.style.filter === '' && document.documentElement.style.fontSize === '' && localStorage.getItem('tc-a11y') === null`));

  // 5. the keyboard: Enter opens and the focus goes into the panel, Esc closes it and the focus goes back to the button
  await ev(`document.querySelector('.a11y-trigger').focus()`);
  if (await visible('.a11y-panel')) await key('Escape', 'Escape', 27); // the panel is still open from the reset above
  await ev(`document.querySelector('.a11y-trigger').focus()`);
  await key('Enter', 'Enter', 13);
  await sleep(300);
  check('keyboard: Enter on the button opens the panel and the focus moves into it', (await visible('.a11y-panel')) && (await ev(`document.querySelector('.a11y-panel').contains(document.activeElement)`)));
  await key('Escape', 'Escape', 27);
  check('keyboard: Esc closes it and the focus is back on the button', !(await visible('.a11y-panel')) && (await ev(`document.activeElement === document.querySelector('.a11y-trigger')`)));

  // 6. the skip link
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(5500);
  await ev(`document.body.focus(); document.activeElement && document.activeElement.blur()`);
  await key('Tab', 'Tab', 9);
  check('the first Tab goes to "skip to the main content", and it is visible', (await ev(`document.activeElement.classList.contains('skip-link')`)) && (await ev(`document.activeElement.getBoundingClientRect().top >= 0`)));
  await key('Enter', 'Enter', 13);
  await sleep(300);
  check('Enter on it moves the focus to the main part', await ev(`document.activeElement.id === 'main-content'`));

  // 7. the statement
  await send('Page.navigate', { url: `${BASE}/accessibility` }); await sleep(5000);
  check('the accessibility statement page: a title and its text', (await ev(`document.querySelector('main h1')?.innerText`)) === 'הצהרת נגישות' && (await ev(`document.body.innerText`)).includes('תפריט נגישות'));
  check('the page title (the tab) is the statement', (await ev(`document.title`)).includes('הצהרת נגישות'), await ev(`document.title`));
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(5000);
  check('the header has a link to it', await ev(`!!document.querySelector('.legal-links a[href="/accessibility"]')`));
  await click(`document.querySelector('.a11y-trigger')`); await sleep(400);
  await click(`document.querySelector('.a11y-statement')`); await sleep(1500);
  check('the link in the panel opens the statement and closes the panel', (await ev('location.pathname')) === '/accessibility' && !(await visible('.a11y-panel')));

  // 8. a phone
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(6000);
  await click(`document.querySelector('.a11y-trigger')`); await sleep(500);
  const box = await ev(`(() => { const r = document.querySelector('.a11y-panel').getBoundingClientRect(); const t = document.querySelector('.a11y-trigger').getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom, t.left, t.right, innerWidth, innerHeight]; })()`);
  check('phone: the panel and the button are inside the screen', box[0] >= 0 && box[1] <= box[6] && box[2] >= 0 && box[3] <= box[7] && box[4] >= 0 && box[5] <= box[6], JSON.stringify(box));
  check('phone: no sideways scroll', await ev('document.documentElement.scrollWidth <= window.innerWidth'));
  await shot('a11y-phone.png');
} finally {
  ws.close(); proc.kill();
  await api(`/api/admin/delete-message/${id}`);
}
console.log(results.every(Boolean) ? '\nALL PASSED' : `\n${results.filter(x => !x).length} FAILED`);
process.exit(results.every(Boolean) ? 0 : 1);
