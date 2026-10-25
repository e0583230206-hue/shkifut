// The manual blur editor in a real Chrome (CDP): open it from the picture's moderator bar, draw, move, resize, undo, delete, preview, save,
// reopen, unsaved-changes question, clear, and drawing with a finger. LOCAL stack only: the backend with MANUAL_BLUR=1 and the real
// moderation service (tests/docker-compose.manual-blur-render.yml, project tc-mb) and the page built with `ng build --configuration development`.
//   node tests/ui/manual_blur_ui.mjs <outDir> http://localhost:18084
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [outDir, base] = process.argv.slice(2);
if (!outDir || !/^http:\/\/localhost:\d+$/.test(base || '') || /:(8080|8081)$/.test(base)) { console.error('usage: manual_blur_ui.mjs <outDir> <local url, e.g. http://localhost:18084>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const MEDIA = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

// ---- setup through the API (node has its own cookie): two pictures, one open and one blurred by hand ----
let cookie = '';
const api = async (path, opt = {}) => {
  const r = await fetch(base + path, { redirect: 'manual', ...opt, headers: { ...(opt.headers || {}), cookie } });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r;
};
await api('/auth/dev-login');
const upload = async (name) => {
  const bytes = Buffer.concat([readFileSync(join(MEDIA, name)), Buffer.from(String(Math.random()))]);
  const fd = new FormData(); fd.append('file', new Blob([bytes], { type: 'image/jpeg' }), name);
  const j = await (await api('/api/admin/upload', { method: 'POST', body: fd })).json();
  return { id: j.url.match(/\/api\/files\/([0-9a-f]{40})/)[1], url: j.url };
};
const post = (path, obj) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
const open = await upload('landscape_hermon.jpg');
await post('/api/admin/files/moderation', { id: open.id, status: 'open' });
const blurred = await upload('painting_starry.jpg');
await post('/api/admin/files/moderation', { id: blurred.id, status: 'blurred' });
await post('/api/admin/new', { type: 'md', text: `עריכה ידנית: תמונה פתוחה\n[image-embedded#](${open.url})` });
await post('/api/admin/new', { type: 'md', text: `תמונה מטושטשת לגמרי\n[image-embedded#](${blurred.url})` });

// ---- Chrome ----
const profile = mkdtempSync(join(tmpdir(), 'mbui-'));
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--remote-debugging-port=9407', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch('http://127.0.0.1:9407/json')).json(); if (t.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('  js error:', r.result.exceptionDetails.exception?.description?.slice(0, 200)); return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); };
const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(150); } return false; };
const key = async (k, mods = 0, code) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: code ?? k, modifiers: mods, windowsVirtualKeyCode: { Delete: 46, ArrowRight: 39, ArrowLeft: 37, z: 90, y: 89 }[k] ?? 0 }); await sleep(120); };

const stageRect = async () => JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector('app-manual-blur .stage').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })())`));
const at = (r, fx, fy) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy });
const mouse = (type, p, buttons = 1) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1 });
const dragMouse = async (a, b, steps = 6) => {
  await mouse('mouseMoved', a, 0); await mouse('mousePressed', a);
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps });
  await mouse('mouseReleased', b); await sleep(150);
};
const dragTouch = async (a, b, steps = 6) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
  for (let i = 1; i <= steps; i++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(200);
};
const count = () => ev(`document.querySelectorAll('app-manual-blur .stage .shape:not(.draft)').length`);
const shapeBox = async (i) => JSON.parse(await ev(`JSON.stringify((() => { const e = document.querySelectorAll('app-manual-blur .stage .shape:not(.draft)')[${i}]; return e && { l: parseFloat(e.style.left), t: parseFloat(e.style.top), w: parseFloat(e.style.width), h: parseFloat(e.style.height) }; })())`));
const clickText = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
const dialogOpen = () => ev(`!!document.querySelector('app-manual-blur')`);
const openEditor = async () => {
  await ev(`(() => { const w = document.querySelector('.mod-wrap[data-file-id="${open.id}"]'); w.scrollIntoView({ block: 'center' }); w.querySelector('.mod-btn-manual').click(); })()`);
  return waitFor(`(() => { const i = document.querySelector('app-manual-blur .stage img'); return !!i && i.complete && i.naturalWidth > 0; })()`);
};
const loadPage = async () => { await send('Page.navigate', { url: base + '/' }); await waitFor(`document.querySelectorAll('.mod-wrap[data-file-id]').length >= 2 && !!document.querySelector('.mod-wrap[data-file-id="${open.id}"] .mod-bar')`, 30000); await sleep(500); };

try {
  await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/auth/dev-login' }); await sleep(1500);
  await loadPage();

  const buttons = await ev(`[...document.querySelectorAll('.mod-wrap[data-file-id]')].map(w => w.dataset.fileId + ':' + !!w.querySelector('.mod-btn-manual')).join(' ')`);
  check('the open picture has a "טשטוש ידני" button', buttons.includes(`${open.id}:true`), buttons);
  check('a picture fully blurred by hand has one too (the manual blur is drawn from scratch on the original)', buttons.includes(`${blurred.id}:true`), buttons);

  check('the editor opens and the picture loads', await openEditor());
  const head = await ev(`document.querySelector('app-manual-blur nb-card-header').textContent`);
  check('it says it is drawn from scratch on the original', head.includes('מהתחלה') && head.includes('התמונה המקורית'), head);
  check('a warning says that what is not marked is shown', (await ev(`document.querySelector('app-manual-blur .note.scratch')?.textContent || ''`)).includes('יוצג לקוראים'));
  check('no shapes yet', (await count()) === 0);
  await shot('1-editor-empty.png');

  let r = await stageRect();
  await dragMouse(at(r, 0.2, 0.2), at(r, 0.5, 0.5));
  check('drag draws a rectangle', (await count()) === 1);
  const b0 = await shapeBox(0);
  check('the rectangle has the dragged size (30% x 30%)', Math.abs(b0.w - 30) < 1.5 && Math.abs(b0.h - 30) < 1.5 && Math.abs(b0.l - 20) < 1.5, JSON.stringify(b0));
  check('it is selected, with 8 handles', (await ev(`document.querySelectorAll('app-manual-blur .shape.selected .handle').length`)) === 8);

  await clickText('app-manual-blur .tool', 'עיגול');
  await dragMouse(at(r, 0.55, 0.5), at(r, 0.85, 0.85));
  check('the ellipse tool draws an ellipse', (await count()) === 2 && (await ev(`document.querySelectorAll('app-manual-blur .shape.ellipse').length`)) === 1);
  check('the counter says 2', (await ev(`document.querySelector('app-manual-blur .count').textContent`)).includes('2'));

  await dragMouse(at(r, 0.9, 0.1), at(r, 0.9, 0.1), 1);
  check('a click without a drag makes no shape', (await count()) === 2);

  await clickText('app-manual-blur .tool', 'הדמיה');
  await sleep(400);
  const pv = JSON.parse(await ev(`JSON.stringify((() => { const c = document.querySelector('app-manual-blur canvas.preview'); const x = c.getContext('2d'); const px = (fx, fy) => x.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data[3]; return { shown: !c.hidden, inRect: px(0.35, 0.35), outside: px(0.05, 0.9), inEllipseCorner: px(0.56, 0.51), inEllipse: px(0.7, 0.68) }; })())`));
  check('the preview draws the shapes only', pv.shown && pv.inRect === 255 && pv.inEllipse === 255 && pv.outside === 0, JSON.stringify(pv));
  check('the preview of an ellipse leaves the corner of its box alone', pv.inEllipseCorner === 0, JSON.stringify(pv));
  await shot('2-editor-two-shapes-preview.png');
  await clickText('app-manual-blur .tool', 'הדמיה');

  await clickText('app-manual-blur .tool', 'בחירה');
  await dragMouse(at(r, 0.35, 0.35), at(r, 0.45, 0.35));
  const b1 = await shapeBox(0);
  check('select tool: dragging a shape moves it (+10%)', Math.abs(b1.l - (b0.l + 10)) < 1.5 && Math.abs(b1.w - b0.w) < 0.5, `${JSON.stringify(b0)} -> ${JSON.stringify(b1)}`);
  r = await stageRect();
  const se = JSON.parse(await ev(`JSON.stringify((() => { const h = document.querySelector('app-manual-blur .shape.selected .handle.h-se').getBoundingClientRect(); return { x: h.left + h.width / 2, y: h.top + h.height / 2 }; })())`));
  await dragMouse(se, { x: se.x + r.w * 0.1, y: se.y + r.h * 0.1 });
  const b2 = await shapeBox(0);
  check('dragging the corner handle resizes it (+10% each way)', Math.abs(b2.w - (b1.w + 10)) < 1.5 && Math.abs(b2.h - (b1.h + 10)) < 1.5 && Math.abs(b2.l - b1.l) < 0.5, `${JSON.stringify(b1)} -> ${JSON.stringify(b2)}`);

  await key('z', 2, 'KeyZ');
  const b3 = await shapeBox(0);
  check('Ctrl+Z undoes the resize', Math.abs(b3.w - b1.w) < 0.5, JSON.stringify(b3));
  await key('y', 2, 'KeyY');
  check('Ctrl+Y does it again', Math.abs((await shapeBox(0)).w - b2.w) < 0.5);
  await key('ArrowRight');
  check('arrow key nudges the selected shape', (await shapeBox(0)).l > b2.l + 0.2, `${b2.l} -> ${(await shapeBox(0)).l}`);
  await key('Delete');
  check('Delete removes the selected shape', (await count()) === 1);
  await key('z', 2, 'KeyZ');
  check('and Ctrl+Z brings it back', (await count()) === 2);
  await clickText('app-manual-blur .tool', 'מחק את כל');   // nothing selected? the button needs a selection: select first
  await shot('3-editor-selected.png');

  const saveDisabledBefore = await ev(`document.querySelector('app-manual-blur .save').disabled`);
  check('"שמור" is enabled when there is something to save', saveDisabledBefore === false);
  const original = await ev(`fetch('/api/files/${open.id}').then(r => r.arrayBuffer()).then(b => b.byteLength)`);
  await ev(`document.querySelector('app-manual-blur .save').click()`);
  check('saving first asks to confirm what readers will see (everything outside the shapes)', await ev(`(document.querySelector('app-manual-blur .confirm-save')?.textContent || '').includes('כל השאר יוצג')`));
  await shot('3b-confirm-save.png');
  await ev(`document.querySelector('app-manual-blur .confirm-yes').click()`);
  check('saving closes the editor', await waitFor(`!document.querySelector('app-manual-blur')`, 20000));
  await sleep(800);
  const badge = await ev(`document.querySelector('.mod-wrap[data-file-id="${open.id}"] .mod-bar').textContent`);
  check('the bar now says "טשטוש ידני פעיל (2)"', badge.includes('טשטוש ידני פעיל (2)'), badge);
  const readerSize = await ev(`fetch('/api/files/${open.id}?view=public').then(r => r.arrayBuffer()).then(b => b.byteLength)`);
  const modSize = await ev(`fetch('/api/files/${open.id}').then(r => r.arrayBuffer()).then(b => b.byteLength)`);
  check('"as readers see" is now a different, smaller picture; the original is untouched', readerSize !== modSize && modSize === original, `${readerSize} / ${modSize} / ${original}`);

  check('reopening loads the saved shapes', (await openEditor()) && (await count()) === 2);
  await ev(`document.querySelector('app-manual-blur .close-btn').click()`);
  check('closing without changes needs no question', await waitFor(`!document.querySelector('app-manual-blur')`, 3000));

  await openEditor();
  r = await stageRect();
  await clickText('app-manual-blur .tool', 'מלבן');
  await dragMouse(at(r, 0.05, 0.6), at(r, 0.2, 0.9));
  await ev(`document.querySelector('app-manual-blur .close-btn').click()`);
  check('closing with changes asks first', await ev(`!!document.querySelector('app-manual-blur .confirm')`));
  await ev(`document.querySelector('app-manual-blur .keep-editing').click()`);
  check('"המשך לערוך" keeps the editor open', (await dialogOpen()) && !(await ev(`!!document.querySelector('app-manual-blur .confirm')`)));
  await ev(`document.querySelector('app-manual-blur .close-btn').click()`);
  await ev(`document.querySelector('app-manual-blur .confirm-close').click()`);
  check('"סגור בלי לשמור" closes it', await waitFor(`!document.querySelector('app-manual-blur')`, 3000));
  await sleep(500);
  check('nothing was saved by that (still 2 shapes)', (await ev(`document.querySelector('.mod-wrap[data-file-id="${open.id}"] .mod-bar').textContent`)).includes('(2)'));

  await openEditor();
  await clickText('app-manual-blur nb-card-footer button', 'מחק את כל הצורות');
  check('"מחק את כל הצורות" empties the editor', (await count()) === 0);
  check('the save button says that saving removes the manual blur', (await ev(`document.querySelector('app-manual-blur .save').textContent`)).includes('הסר'));
  await ev(`document.querySelector('app-manual-blur .save').click()`);   // removing needs no confirmation
  await waitFor(`!document.querySelector('app-manual-blur')`, 20000); await sleep(800);
  check('saving with no shapes removes the manual blur', !(await ev(`document.querySelector('.mod-wrap[data-file-id="${open.id}"] .mod-bar').textContent`)).includes('טשטוש ידני פעיל'));

  // dark theme
  await ev(`localStorage.setItem('tc-theme', 'dark')`);
  await loadPage();
  await openEditor();
  r = await stageRect();
  await dragMouse(at(r, 0.25, 0.25), at(r, 0.6, 0.6));
  await shot('4-editor-dark.png');
  await ev(`document.querySelector('app-manual-blur .close-btn').click()`); await ev(`document.querySelector('app-manual-blur .confirm-close')?.click()`);
  await ev(`localStorage.setItem('tc-theme', 'light')`);

  // a phone, with a finger
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await loadPage();
  check('phone: the editor opens', await openEditor());
  r = await stageRect();
  await dragTouch(at(r, 0.2, 0.25), at(r, 0.6, 0.6));
  check('phone: a finger draws a rectangle', (await count()) === 1);
  const fits = await ev(`document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('app-manual-blur nb-card').getBoundingClientRect().width <= innerWidth`);
  check('phone: the editor fits the screen', fits);
  await shot('5-editor-phone.png');
} catch (e) { console.log('ERROR', e); results.push(false); }
try { ws.close(); proc.kill(); } catch {}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME CHECKS FAILED');
process.exit(0);
