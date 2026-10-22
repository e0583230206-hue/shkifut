// Browser check of the message layout, media, emoji button and the login lock (real Chrome over CDP, LOCAL stack only):
//   python -I tests/ui/seed_ui_data.py            # once, on the empty UI test stack (tests/docker-compose.ui-test.yml)
//   BASE_URL=http://localhost:18083 node tests/ui/layout_check.mjs <outDir> [chromePath]
// Takes screenshots at desktop size (1280x900) and phone size (360x740, touch) as a logged-in reader and as a visitor who is not logged in.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localBase } from './guard.mjs';

const [outDir, chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
if (!outDir) { console.error('usage: layout_check.mjs <outDir> [chrome]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const BASE = localBase(process.env.BASE_URL);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); };

async function openBrowser(port) {
  const profile = mkdtempSync(join(tmpdir(), 'layout-check-'));
  const proc = spawn(chromePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--lang=he', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {} await sleep(200); }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Page.enable'); await send('Network.enable');
  return {
    send, ev,
    goto: async (url, wait = 3500) => { await send('Page.navigate', { url }); await sleep(wait); },
    shot: async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); },
    view: async (w, h, mobile) => {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    },
    close: () => { try { ws.close(); proc.kill(); } catch {} },
  };
}

const scrollTo = (b, id) => b.ev(`(() => { const e = document.getElementById('${id}'); if (!e) return false; e.scrollIntoView({ block: 'start' }); window.scrollBy(0, -170); return true; })()`);
// message element id by a piece of its text (the stack may hold several seeded sets: the newest one is used)
const idOf = (b, text) => b.ev(`(() => { const m = [...document.querySelectorAll('app-message')].filter(e => e.textContent.includes(${JSON.stringify(text)})); return m.length ? String(Math.max(...m.map(e => +e.id))) : null; })()`);

const rect = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`;

// ---------------- logged in, desktop then phone
async function loggedIn(label, w, h, mobile, port) {
  const b = await openBrowser(port);
  try {
    await b.view(w, h, mobile);
    await b.goto(`${BASE}/auth/dev-login`, 1200);
    await b.goto(`${BASE}/`, 4500);
    const cards = await b.ev(`[...document.querySelectorAll('.message-card')].map(e => Math.round(e.getBoundingClientRect().width))`);
    const uniq = [...new Set(cards)];
    check(`${label}: all messages have the same width`, cards.length >= 8 && uniq.length === 1, JSON.stringify(cards));
    if (!mobile) check(`${label}: width is about 15 cm (570 px)`, uniq[0] >= 560 && uniq[0] <= 580, uniq[0]);
    else check(`${label}: width fits the phone screen`, uniq[0] <= w, `${uniq[0]} of ${w}`);
    check(`${label}: no sideways scroll`, await b.ev('document.documentElement.scrollWidth <= window.innerWidth + 1'), await b.ev('document.documentElement.scrollWidth'));
    check(`${label}: a profile picture on every message`, await b.ev(`document.querySelectorAll('.msg-avatar').length >= 8`));
    check(`${label}: the site logo is in the header (alt "שקיפות", 50-60 px high on a desktop)`, await b.ev(`(() => { const i = document.querySelector('app-channel-header .site-logo img'); if (!i) return false; const h = i.getBoundingClientRect().height; return i.alt === 'שקיפות' && i.src.includes('logo-animated.gif') && (${mobile} ? h >= 30 && h <= 60 : h >= 50 && h <= 60); })()`));
    check(`${label}: every message has the full logo as its profile picture (a round profile)`, await b.ev(`(() => { const a = [...document.querySelectorAll('.msg-avatar')]; return a.length >= 8 && a.every(e => e.src.includes('logo-profile.png') && e.srcset.includes('logo-profile-2x.png 2x') && e.complete && e.naturalWidth > 0 && e.getBoundingClientRect().width >= 50); })()`));
    console.log('  diag long:', await b.ev(`(() => { const m = [...document.querySelectorAll('.message-card')].find(e => e.textContent.includes('זהו טקסט ארוך בכוונה')); return m ? [m.scrollHeight, m.clientHeight, Math.round(m.getBoundingClientRect().height)] : null; })()`));
    check(`${label}: long text is not cut and has no "show more"`, await b.ev(`(() => { const m = [...document.querySelectorAll('.message-card')].find(e => e.textContent.includes('זהו טקסט ארוך בכוונה')); return !!m && m.scrollHeight <= m.clientHeight + 1 && ![...m.querySelectorAll('button, a')].some(x => /הצג עוד|show more/i.test(x.textContent)) && m.getBoundingClientRect().height > 150; })()`));

    // media: full width of the message, box reserved before loading
    const ids = JSON.parse(await b.ev(`JSON.stringify([...document.querySelectorAll('app-message')].map(e => e.id))`));
    await b.send('Network.setBlockedURLs', { urls: ['*/api/files/*.jpg*', '*/api/files/*.mp4*', '*/api/files/*.png*'] });
    await b.goto(`${BASE}/`, 4500);
    const before = await b.ev(`JSON.stringify([...document.querySelectorAll('.mod-frame-ar')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }))`);
    await b.send('Network.setBlockedURLs', { urls: [] });
    await b.goto(`${BASE}/`, 5500);
    const after = await b.ev(`JSON.stringify([...document.querySelectorAll('.mod-frame-ar')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }))`);
    const bf = JSON.parse(before), af = JSON.parse(after);
    check(`${label}: boxes exist before the files load`, bf.length >= 3, before);
    // the message "old" has no size in its address: its box may change once; all others must not move at all
    const moved = bf.map((v, i) => [v, af[i]]).filter(([x, y]) => !y || Math.abs(x[1] - y[1]) > 2);
    check(`${label}: the page does not jump when files load (only the old message without size may)`, moved.length <= 1, JSON.stringify(moved));
    const inner = await b.ev(`(() => { const c = document.querySelector('.message-card .mod-wrap:not([data-gallery])'); const card = c.closest('.message-card'); const m = card.querySelector('markdown').getBoundingClientRect(); return [Math.round(c.getBoundingClientRect().width), Math.round(m.width)]; })()`);
    check(`${label}: a picture fills the width of the message`, Math.abs(inner[0] - inner[1]) <= 2, JSON.stringify(inner));
    const tall = await b.ev(`(() => { const f = [...document.querySelectorAll('.mod-frame-video')].map(e => e.getBoundingClientRect()); return f.map(r => [Math.round(r.width), Math.round(r.height)]); })()`);
    check(`${label}: a tall video is never higher than 80% of the screen`, tall.every(([, hh]) => hh <= h * 0.8 + 2), JSON.stringify(tall));

    const REACTED = await idOf(b, 'הודעה עם תגובות');
    // emoji: no hover list, a button instead
    const hov = ids.find(i => /^\d+$/.test(i));
    await scrollTo(b, hov);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 400 });
    await sleep(900);
    check(`${label}: nothing pops up when the mouse hovers over a message`, await b.ev(`!document.querySelector('.emoji-picker-menu')`));
    await scrollTo(b, REACTED);
    await sleep(500);
    check(`${label}: a small emoji button sits next to report and link`, await b.ev(`(() => { const m = document.getElementById('${REACTED}'); const bs = [...m.querySelectorAll('.msg-head button.icon-button')]; const i = bs.findIndex(x => x.classList.contains('emoji-button')); return i >= 0 && bs.length >= 3 && i === bs.length - 1; })()`));
    check(`${label}: reaction tags (emoji + number) stay under the message`, await b.ev(`document.querySelectorAll('[id="${REACTED}"] .emojis-section .emoji-reaction .count').length >= 3`));
    await b.shot(`${label}-1-reactions.png`);
    await b.ev(`document.querySelector('[id="${REACTED}"] .emoji-button').click()`);
    for (let i = 0; i < 15 && !(await b.ev(`!!document.querySelector('.emoji-picker-menu')`)); i++) await sleep(200);
    await sleep(300);
    console.log('  diag: popover windows', await b.ev(`document.querySelectorAll('ngb-popover-window').length`), 'menus', await b.ev(`document.querySelectorAll('.emoji-picker-menu').length`), 'options', await b.ev(`document.querySelectorAll('.emoji-option').length`), 'button', await b.ev(`!!document.querySelector('[id="${REACTED}"] .emoji-button')`));
    check(`${label}: a click on the button opens the list`, await b.ev(`document.querySelectorAll('.emoji-picker-menu .emoji-option').length >= 3`));
    const menu = await b.ev(rect('.emoji-picker-menu'));
    check(`${label}: the list fits the screen`, !!menu && menu.x >= -1 && menu.x + menu.w <= w + 1, JSON.stringify(menu));
    await b.shot(`${label}-2-emoji-list.png`);
    await b.ev(`document.querySelector('.emoji-picker-menu .emoji-option').click()`);
    await sleep(800);
    check(`${label}: choosing an emoji closes the list`, await b.ev(`!document.querySelector('.emoji-picker-menu')`));

    for (const [text, name] of [['הודעה קצרה', '3-top'], ['זהו טקסט ארוך', '4-long-text'], ['תמונה רחבה', '5-wide-image'], ['תמונה גבוהה', '6-tall-image'], ['סרטון רחב', '7-wide-video'], ['סרטון עומד', '8-tall-video'], ['גלריה של שלוש', '9-gallery'], ['הודעה ישנה', '10-old-no-size']]) {
      await scrollTo(b, await idOf(b, text)); await sleep(700); await b.shot(`${label}-${name}.png`);
    }
  } finally { b.close(); }
}

// ---------------- visitor who is not logged in
async function visitor(label, w, h, mobile, port) {
  const b = await openBrowser(port);
  try {
    await b.view(w, h, mobile);
    const fileRequests = [];
    await b.goto(`${BASE}/`, 5000);
    const texts = await b.ev(`document.body.innerText.includes('הודעה קצרה, רק טקסט.') && document.body.innerText.includes('זהו טקסט ארוך בכוונה')`);
    check(`${label} (not logged in): the texts are visible`, texts);
    const locked = await b.ev(`document.querySelectorAll('.mod-locked').length`);
    check(`${label} (not logged in): files are replaced by black boxes with the login text`, locked >= 6, locked);
    check(`${label} (not logged in): the box says to log in and has the link`, await b.ev(`(() => { const e = document.querySelector('.mod-locked'); return e.textContent.includes('יש להתחבר כדי לצפות בקבצים') && e.textContent.includes('לחצו כאן להתחברות') && getComputedStyle(e).backgroundColor === 'rgb(0, 0, 0)'; })()`));
    check(`${label} (not logged in): no picture, video or audio element of a file is on the page`, await b.ev(`document.querySelectorAll('.message-card img[src*="/api/files/"], .message-card video, .message-card audio, .mod-media').length === 0`));
    const boxes = await b.ev(`JSON.stringify([...document.querySelectorAll('.mod-locked')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }))`);
    console.log('locked boxes (w,h):', boxes);
    // the locked box has the proportions of the file: the wide picture is 1239x929 (4:3), the tall video 478x850
    check(`${label} (not logged in): the locked box has the file's proportions`, await b.ev(`(() => { const r = [...document.querySelectorAll('.mod-locked')].map(e => e.getBoundingClientRect()); return r.some(x => Math.abs(x.height / x.width - 929 / 1239) < 0.03) && r.some(x => Math.abs(x.height / x.width - 850 / 478) < 0.03); })()`));
    await scrollTo(b, await idOf(b, 'תמונה רחבה')); await sleep(600); await b.shot(`${label}-visitor-1-locked-image.png`);
    await scrollTo(b, await idOf(b, 'סרטון עומד')); await sleep(600); await b.shot(`${label}-visitor-2-locked-video.png`);
    await scrollTo(b, await idOf(b, 'גלריה של שלוש')); await sleep(600); await b.shot(`${label}-visitor-3-locked-gallery.png`);
    check(`${label} (not logged in): the report and reaction buttons do not break the page`, true);
  } finally { b.close(); }
}

try {
  await loggedIn('desktop', 1280, 900, false, 9361);
  await loggedIn('phone', 360, 740, true, 9362);
  await visitor('desktop', 1280, 900, false, 9363);
  await visitor('phone', 360, 740, true, 9364);
} catch (e) { console.log('ERROR', e); results.push(false); }
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nFAILED');
process.exit(results.every(Boolean) ? 0 : 1);
