import {
  fetchMessages, fetchPinned, getBase, plain, rich, extractMedia, loadMedia, DEFAULT_BASE,
  fetchChannelInfo, loadLogo, fetchEmojis, sendReaction, fetchMessage, sendReport,
} from './common.js';
import { getSettings, saveSettings, isMuted, tomorrowMorning } from './settings.js';
import { SOUNDS, playSound } from './sounds.js';

const $ = (id) => document.getElementById(id);
const PAGE = 30;
const LONG_TEXT = 300; // longer messages are folded behind "קרא עוד"
const MODE = new URLSearchParams(location.search).get('embed'); // 'hover' | 'dock' | null (the side panel)

const S = {
  base: '', info: { name: 'שקיפות', logoUrl: '', contact: '' }, emojis: [],
  loaded: 0, topId: 0, ids: new Set(),
  stick: true,      // the reader is at the bottom: new messages scroll into view
  ready: false, busy: false, hasMore: false, pending: 0, minimized: false,
};

const link = (href, text) => Object.assign(document.createElement('a'), { href, target: '_blank', textContent: text });
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function svg(attrs, ...children) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs })) s.setAttribute(k, v);
  for (const [tag, a] of children) {
    const c = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) c.setAttribute(k, v);
    s.append(c);
  }
  return s;
}
const linkIcon = () => svg({}, ['path', { d: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7' }], ['path', { d: 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7' }]);
// a smiling face with a small plus: "react here"
const reactIcon = () => svg({}, ['circle', { cx: '11', cy: '12', r: '9' }], ['path', { d: 'M7.5 14a4.5 4.5 0 0 0 7 0' }],
  ['path', { d: 'M8.5 9.5h.01M13.5 9.5h.01' }], ['path', { d: 'M19 2v6M16 5h6' }]);

// "לפני 5 דקות" for fresh messages, a date for older ones
function when(ts) {
  const t = new Date(ts);
  const min = Math.floor((Date.now() - t.getTime()) / 60000);
  if (min < 1) return 'עכשיו';
  if (min < 60) return `לפני ${min} דקות`;
  if (min < 24 * 60 && new Date().getDate() === t.getDate()) return `היום ב-${t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  return t.toLocaleString('he-IL', { dateStyle: 'medium', timeStyle: 'short' });
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const y = new Date(); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'היום';
  if (d.toDateString() === y.toDateString()) return 'אתמול';
  return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
}
function stamp() { $('updated').textContent = 'ערוץ חדשות · עודכן ' + new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); }

function applyLook(s) {
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.dataset.font = s.font;
}

let toastTimer = null;
function toast(...parts) {
  const t = $('toast');
  t.replaceChildren(...parts);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}
const loginToast = (what) => toast(`צריך להתחבר באתר כדי ${what}. `, link(S.base, 'לפתיחת האתר'));

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
  try {
    const ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}

// --- the window around this page (hover preview / docked window in Gmail) ---
const toHost = (cmd) => parent.postMessage({ src: 'skifut', cmd }, '*');
window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== parent || !d || d.src !== 'skifut-host') return;
  if (d.cmd === 'min') { S.minimized = !!d.value; updateChip(); if (!S.minimized) resetUnread(); }
});
async function updateChip() {
  const { unread = 0 } = await chrome.storage.local.get('unread');
  $('chip').textContent = unread > 99 ? '99+' : String(unread);
  $('chip').hidden = !(S.minimized && unread > 0);
}
if (MODE === 'hover') { $('openDock').hidden = false; $('openDock').onclick = () => toHost('dock'); }
if (MODE === 'dock') {
  $('min').hidden = false; $('close').hidden = false;
  $('min').onclick = () => toHost('min');
  $('close').onclick = () => toHost('close');
  $('brand').style.cursor = 'pointer';
  $('brand').onclick = () => toHost('min');
}

// --- images in full size ---
function openLightbox(src) {
  const box = el('div', 'lightbox');
  const img = el('img'); img.src = src; img.alt = '';
  box.append(img);
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  box.onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.append(box);
}

// --- media: images load when they scroll into view; a video loads only after a click ---
const MEDIA_ERR = (e) => (e.status === 401 ? 'צריך להתחבר באתר כדי לראות מדיה' : 'המדיה ממתינה לאישור או לא זמינה');
const lazy = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    lazy.unobserve(en.target);
    const box = en.target;
    loadMedia(box.dataset.path)
      .then((src) => {
        const img = el('img'); img.src = src; img.alt = ''; img.title = 'הגדלה';
        img.onclick = () => openLightbox(src);
        box.replaceChildren(img);
      })
      .catch((e) => { box.textContent = MEDIA_ERR(e); });
  }
}, { rootMargin: '300px' });

function mediaBox(md) {
  const box = el('div', 'media-box');
  box.dataset.path = md.path;
  if (md.kind === 'video') {
    const b = el('button', '', '▶ ניגון סרטון');
    b.onclick = async () => {
      b.disabled = true; b.textContent = 'טוען…';
      try {
        const v = el('video'); v.controls = true; v.playsInline = true; v.src = await loadMedia(md.path);
        box.replaceChildren(v); v.play().catch(() => {});
      } catch (e) { box.textContent = MEDIA_ERR(e); }
    };
    box.append(b);
  } else {
    box.textContent = 'טוען תמונה…';
    lazy.observe(box);
  }
  return box;
}

// --- header of a message ---
function avatar(info) {
  const a = el('div', 'avatar', (info.name || 'ש').trim().charAt(0));
  if (info.logoUrl) {
    loadLogo(info.logoUrl).then((src) => {
      if (!src) return;
      const img = el('img'); img.src = src; img.alt = '';
      a.replaceChildren(img);
    }).catch(() => {});
  }
  return a;
}

// --- reactions ---
function reactionsBar(m) {
  const bar = el('div', 'reactions');
  for (const [emoji, n] of Object.entries(m.reactions || {})) {
    if (!(n > 0)) continue;
    const b = el('button', 'chip', `${emoji} ${n}`);
    b.onclick = () => react(m, emoji, bar);
    bar.append(b);
  }
  if (S.emojis.length) {
    const add = el('button', 'chip add');
    add.title = 'הגב באמוג׳י';
    add.setAttribute('aria-label', 'הגב באמוג׳י');
    add.append(reactIcon(), el('span', '', 'הגב'));
    const tray = el('span', 'tray');
    tray.hidden = true;
    for (const e of S.emojis) {
      const eb = el('button', 'chip', e);
      eb.onclick = () => react(m, e, bar);
      tray.append(eb);
    }
    add.onclick = () => { tray.hidden = !tray.hidden; };
    bar.append(add, tray);
  }
  return bar;
}

async function react(m, emoji, bar) {
  const r = await sendReaction(m.id, emoji);
  if (r.status === 401) { loginToast('להגיב'); return; }
  if (!r.ok) { toast('לא הצלחתי לשלוח תגובה. נסה שוב.'); return; }
  const fresh = await fetchMessage(m.id); // counts as the site now holds them
  if (fresh) { m.reactions = fresh.reactions; bar.replaceWith(reactionsBar(m)); }
}

// --- report (to the site's moderators) ---
function reportForm(m) {
  const f = el('div', 'report');
  const ta = el('textarea'); ta.rows = 3; ta.maxLength = 500; ta.placeholder = 'מה הבעיה בהודעה? (תוכן בעייתי, תמונה, טעות...)';
  const row = el('div', 'row');
  const send = el('button', '', 'שליחת דיווח לאתר');
  const cancel = el('button', '', 'ביטול');
  row.append(send, cancel);
  f.append(ta, row);

  cancel.onclick = () => f.remove();
  send.onclick = async () => {
    const reason = ta.value.trim();
    if (reason.length < 3) { toast('כתוב בקצרה מה הבעיה (לפחות 3 תווים).'); return; }
    send.disabled = true;
    const r = await sendReport(m.id, reason);
    send.disabled = false;
    if (r.ok) { toast('הדיווח נשלח לבדיקה. תודה.'); f.remove(); }
    else if (r.status === 401) loginToast('לדווח');
    else if (r.status === 409) toast('כבר דיווחת על הודעה זו היום.');
    else if (r.status === 429) toast('יותר מדי דיווחים. נסה שוב מאוחר יותר.');
    else toast('לא הצלחתי לשלוח את הדיווח. נסה שוב.');
  };
  return f;
}

// --- one message ---
function messageCard(m) {
  const d = el('article', 'msg');
  d.dataset.id = m.id;
  d.dataset.ts = String(new Date(m.timestamp).getTime());
  const url = `${S.base}/m/${m.id}`;

  const head = el('div', 'head');
  const who = el('div', 'who');
  const time = el('time', '', when(m.timestamp));
  time.title = new Date(m.timestamp).toLocaleString('he-IL');
  who.append(el('strong', '', S.info.name), time);
  const a = link(url, ''); a.className = 'permalink'; a.title = 'פתיחה באתר'; a.setAttribute('aria-label', 'פתיחה באתר'); a.append(linkIcon());
  head.append(avatar(S.info), who, a);
  d.append(head);

  const media = extractMedia(m);
  const text = rich(m.text, 5000);
  let title = '', body = text;
  const nl = text.indexOf('\n');
  if (nl > 0 && nl <= 90) { title = text.slice(0, nl).trim(); body = text.slice(nl + 1).trim(); } // first line = headline
  if (title) d.append(el('div', 'title', title));
  const p = el('p', text ? 'body' : 'body media', body || (title ? '' : media.length ? '' : 'הודעה עם מדיה. לצפייה באתר'));
  if (body || !title) d.append(p);
  if (body && (body.length > LONG_TEXT || (body.match(/\n/g) || []).length > 6)) {
    p.classList.add('clamp');
    const more = el('button', 'linkish', 'קרא עוד');
    more.onclick = () => { const open = p.classList.toggle('clamp'); more.textContent = open ? 'קרא עוד' : 'הצג פחות'; };
    d.append(more);
  }
  for (const md of media) d.append(mediaBox(md));

  const foot = el('div', 'foot');
  foot.append(reactionsBar(m));
  const acts = el('div', 'acts');
  const copy = el('button', 'linkish', 'העתק');
  copy.onclick = async () => toast((await copyText(`${text}\n${url}`.trim())) ? 'ההודעה הועתקה.' : 'ההעתקה נכשלה.');
  const share = el('button', 'linkish', 'שיתוף');
  share.onclick = async () => {
    if (navigator.share) { try { await navigator.share({ title: S.info.name, text: text.slice(0, 200), url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    toast((await copyText(url)) ? 'הקישור הועתק.' : 'ההעתקה נכשלה.');
  };
  const report = el('button', 'linkish', 'דיווח');
  report.onclick = () => { const ex = d.querySelector('.report'); if (ex) ex.remove(); else d.append(reportForm(m)); };
  acts.append(copy, share, report);
  foot.append(acts);
  d.append(foot);
  return d;
}

// day dividers ("היום", "אתמול"...) are rebuilt after every change of the list
function relayoutDays() {
  const list = $('list');
  list.querySelectorAll('.day').forEach((n) => n.remove());
  let prev = '';
  for (const c of list.querySelectorAll('.msg')) {
    const ts = Number(c.dataset.ts);
    const day = new Date(ts).toDateString();
    if (day !== prev) { prev = day; c.before(el('div', 'day', dayLabel(ts))); }
  }
}

// --- scrolling: a chat. Oldest at the top, newest at the bottom, scrolling up loads older ones ---
const fromBottom = () => document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
const toBottom = () => window.scrollTo(0, document.documentElement.scrollHeight);
new ResizeObserver(() => { if (S.stick) toBottom(); }).observe($('list')); // images that load keep the bottom in view

function resetUnread() {
  if (S.minimized) return;
  chrome.storage.local.set({ seenId: S.topId, unread: 0 });
  chrome.action.setBadgeText({ text: '' });
}

let posTimer = null;
function onScroll() {
  if (!S.ready) return;
  S.stick = fromBottom() < 80;
  $('down').hidden = fromBottom() < 400;
  if (S.stick) { S.pending = 0; $('newPill').hidden = true; resetUnread(); }
  if (window.scrollY < 250 && S.hasMore && !S.busy) loadOlder();
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    const head = document.querySelector('header').getBoundingClientRect().bottom;
    const first = [...document.querySelectorAll('#list .msg')].find((c) => c.getBoundingClientRect().bottom > head + 10);
    if (first) chrome.storage.local.set({ pos: { id: Number(first.dataset.id) } });
  }, 500);
}
window.addEventListener('scroll', onScroll, { passive: true });
$('down').onclick = () => toBottom();
$('newPill').onclick = () => { toBottom(); S.pending = 0; $('newPill').hidden = true; };
$('more').onclick = () => loadOlder();
$('refresh').onclick = () => render();

// --- loading ---
function renderPinned(pins) {
  $('pinned').replaceChildren();
  for (const p of pins) {
    const d = el('div', 'pin');
    d.append(el('p', '', '📌 ' + (plain(p.snippet, 200) || 'הודעה מוצמדת')), link(`${S.base}/m/${p.id}`, 'פתיחה באתר'));
    $('pinned').append(d);
  }
}

async function render() {
  S.ready = false;
  S.base = await getBase();
  $('status').textContent = 'טוען…';
  const { pos } = await chrome.storage.local.get('pos');
  const [r, pins, info, emojis] = await Promise.all([fetchMessages(PAGE, 0), fetchPinned(), fetchChannelInfo(), fetchEmojis()]);
  S.info = info; S.emojis = emojis;
  const list = $('list');
  list.replaceChildren();
  S.ids.clear(); S.loaded = 0; S.topId = 0; S.pending = 0;
  $('more').hidden = true; $('resume').hidden = true; $('newPill').hidden = true;

  if (r.status === 401) {
    $('status').replaceChildren('צריך להתחבר באתר (בדפדפן הזה) כדי לראות הודעות. ', link(S.base, 'לפתיחת האתר'));
    return;
  }
  if (!r.ok) { $('status').textContent = 'לא הצלחתי להתחבר לאתר. בדוק את הכתובת או נסה שוב.'; return; }
  $('status').textContent = r.messages.length ? '' : 'אין הודעות.';
  renderPinned(pins);

  for (const m of [...r.messages].reverse()) { S.ids.add(m.id); list.append(messageCard(m)); } // oldest first
  S.loaded = r.raw;
  S.cursor = r.last; // "load older" continues after this message
  S.topId = r.messages.length ? r.messages[0].id : 0; // r.messages is newest first
  S.hasMore = r.raw >= PAGE;
  $('more').hidden = !S.hasMore;
  relayoutDays();
  stamp();

  S.stick = true;
  requestAnimationFrame(() => { toBottom(); S.ready = true; });
  resetUnread();

  // "continue where you stopped": a pill, only when that message is not the newest
  if (pos && pos.id && pos.id !== S.topId) {
    const target = list.querySelector(`.msg[data-id="${pos.id}"]`);
    if (target) {
      $('resume').hidden = false;
      $('resumeGo').onclick = () => { S.stick = false; target.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('resume').hidden = true; };
      $('resumeX').onclick = () => { $('resume').hidden = true; };
    }
  }
}

async function loadOlder() {
  if (S.busy || !S.hasMore) return;
  S.busy = true; $('more').disabled = true;
  const prevH = document.documentElement.scrollHeight, prevY = window.scrollY;
  if (!S.cursor) { S.busy = false; $('more').disabled = false; return; } // 0 would mean "from the newest" again
  const r = await fetchMessages(PAGE, S.cursor);
  if (!r.ok) { S.busy = false; $('more').disabled = false; toast('לא הצלחתי לטעון הודעות ישנות.'); return; }
  const frag = document.createDocumentFragment();
  let added = 0;
  for (const m of [...r.messages].reverse()) { if (S.ids.has(m.id)) continue; S.ids.add(m.id); frag.append(messageCard(m)); added++; }
  S.loaded += r.raw;
  if (r.last) S.cursor = r.last;
  S.hasMore = r.raw >= PAGE;
  $('more').hidden = !S.hasMore;
  $('list').prepend(frag);
  relayoutDays();
  window.scrollTo(0, prevY + (document.documentElement.scrollHeight - prevH)); // keep what the reader looks at in place
  S.busy = false; $('more').disabled = false;
  if (S.hasMore && (!added || document.documentElement.scrollHeight < window.innerHeight * 1.5)) loadOlder();
}

// every minute: add only the messages that arrived since, at the bottom
async function refreshNew() {
  if (!S.ready) return;
  const r = await fetchMessages(PAGE, 0, true); // the minute refresh of an open window is not a new view
  if (!r.ok) return;
  stamp();
  const fresh = r.messages.filter((m) => m.id > S.topId && !S.ids.has(m.id)).reverse(); // oldest first
  if (!fresh.length) return;
  for (const m of fresh) { S.ids.add(m.id); $('list').append(messageCard(m)); }
  S.topId = fresh[fresh.length - 1].id;
  S.loaded += fresh.length;
  $('status').textContent = '';
  relayoutDays();
  if (S.stick) { toBottom(); resetUnread(); }
  else { S.pending += fresh.length; $('newPill').textContent = `↓ ${S.pending} הודעות חדשות`; $('newPill').hidden = false; }
}

// --- settings ---
const UNIT_MS = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };

function showMuteInfo(s) {
  $('muteInfo').textContent = isMuted(s)
    ? 'מושתק עד ' + new Date(s.mutedUntil).toLocaleString('he-IL', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'ההתראות פעילות';
}

async function initSettings() {
  let s = await getSettings();
  applyLook(s);
  for (const [k, v] of Object.entries(SOUNDS)) $('sound').append(new Option(v.label, k));
  $('notify').checked = s.notify;
  $('soundOn').checked = s.soundOn;
  $('sound').value = s.sound;
  $('font').value = s.font;
  $('theme').value = s.theme;
  $('showInGmail').checked = s.showInGmail;
  $('base').value = await getBase();
  showMuteInfo(s);

  const bind = (id, key, get = (e) => e.value) =>
    ($(id).onchange = async (e) => { s = await saveSettings({ [key]: get(e.target) }); applyLook(s); });
  bind('notify', 'notify', (e) => e.checked);
  bind('soundOn', 'soundOn', (e) => e.checked);
  bind('sound', 'sound');
  $('font').onchange = async (e) => { s = await saveSettings({ font: e.target.value, fontChosen: true }); applyLook(s); };
  bind('theme', 'theme');
  bind('showInGmail', 'showInGmail', (e) => e.checked);

  $('test').onclick = () => playSound($('sound').value);
  $('sound').addEventListener('change', () => playSound($('sound').value));

  const mute = async (until, msg) => { s = await saveSettings({ mutedUntil: until }); showMuteInfo(s); toast(msg); };
  $('muteGo').onclick = () => {
    const n = Math.max(1, Math.min(999, Math.floor(Number($('muteN').value)) || 1));
    mute(Date.now() + n * UNIT_MS[$('muteUnit').value], 'ההתראות הושתקו.');
  };
  $('muteTomorrow').onclick = () => mute(tomorrowMorning(), 'ההתראות הושתקו עד מחר בבוקר.');
  $('muteOff').onclick = () => mute(0, 'ההשתקה בוטלה.');

  $('base').onchange = async (e) => {
    const v = e.target.value.trim().replace(/\/+$/, '') || DEFAULT_BASE;
    if (!/^https?:\/\//.test(v)) return;
    await chrome.storage.local.set({ base: v });
    render();
  };
}

// what the background check did last: helps to see why a counter is (not) shown
async function showDiag() {
  const { lastCheck, lastStatus, unread = 0 } = await chrome.storage.local.get(['lastCheck', 'lastStatus', 'unread']);
  $('diag').textContent = lastCheck
    ? `בדיקה ברקע: ${new Date(lastCheck).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} · האתר: ${lastStatus === 200 ? 'מגיב' : lastStatus ? 'שגיאה ' + lastStatus : 'אין חיבור'} · הודעות חדשות שלא נקראו: ${unread}`
    : 'עדיין לא בוצעה בדיקה ברקע (היא רצה אחת לדקה).';
}

function toggleSettings(show) {
  $('settings').hidden = !show;
  $('view').hidden = show;
  if (show) showDiag();
  if (show) { for (const id of ['resume', 'newPill', 'down']) $(id).hidden = true; }
}
$('gear').onclick = () => toggleSettings($('settings').hidden);
$('back').onclick = () => toggleSettings(false);

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.settings) applyLook({ ...ch.settings.newValue });
  if (ch.unread) updateChip();
});

initSettings();
render();
setInterval(() => { if (!$('view').hidden) refreshNew(); }, 60000);
