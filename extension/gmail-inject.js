// Runs inside Gmail: adds a "שקיפות" item to the left/right menu with an unread counter.
// Hovering over it shows a quick preview window; a click opens it as a docked window at the bottom corner (like a chat window).
(() => {
  const ITEM_ID = 'skifut-item';
  const FAB_ID = 'skifut-fab';
  const started = Date.now();
  const DOCK_ID = 'skifut-dock';
  let hover = null, dock = null, hoverTimer = null, openTimer = null;

  const ctxOk = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  function badgeText(n) { return n > 99 ? '99+' : String(n); }

  function setBadges(n) {
    document.querySelectorAll('.skifut-badge').forEach((b) => {
      b.textContent = badgeText(n);
      b.style.display = n > 0 ? 'inline-block' : 'none';
    });
  }

  async function refreshBadge() {
    if (!ctxOk()) return;
    const { unread = 0 } = await chrome.storage.local.get('unread');
    setBadges(unread);
  }

  function broadcastIcon() { // an outline "broadcast channel" icon in the colour of Gmail's own icons
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '2');
    const d = document.createElementNS(NS, 'path');
    d.setAttribute('d', 'M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2');
    svg.append(c, d);
    return svg;
  }

  function makeItem(floating) {
    const el = document.createElement(floating ? 'button' : 'div');
    el.id = floating ? FAB_ID : ITEM_ID;
    el.className = floating ? 'skifut-fab' : 'skifut-item';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = 'שקיפות - ערוץ חדשות';
    const icon = document.createElement('span');
    icon.className = 'skifut-icon';
    icon.append(broadcastIcon());
    const label = document.createElement('span');
    label.className = 'skifut-label';
    label.textContent = 'שקיפות';
    const badge = document.createElement('span');
    badge.className = 'skifut-badge';
    badge.style.display = 'none';
    el.append(icon);
    if (!floating) el.append(label);
    if (floating) el.append(badge); else icon.append(badge); // in the rail the counter sits on the icon, like Gmail's own
    el.addEventListener('click', (e) => { e.stopPropagation(); toggleDock(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDock(); } });
    el.addEventListener('mouseenter', () => { clearTimeout(hoverTimer); clearTimeout(openTimer); openTimer = setTimeout(() => showHover(el), 250); });
    el.addEventListener('mouseleave', () => { clearTimeout(openTimer); scheduleHide(); });
    return el;
  }

  // The narrow rail at the edge of Gmail (Mail / Chat / Meet). We go under "Meet";
  // if Meet is switched off we go under Chat, then under Mail.
  // The rail is found from what is really on screen: we look at the strip along both edges of the window.
  const RAIL_NAMES = {
    meet: /(^|\s)(meet|מיט)(\s|$|[-–,:])/i,
    chat: /(^|\s)(chat|צ['׳’]אט)(\s|$|[-–,:])/i,
    mail: /(^|\s)(mail|דואר)(\s|$|[-–,:])/i,
  };
  const RAIL_ORDER = ['meet', 'chat', 'mail'];

  function railItems() {
    const found = {};
    const w = window.innerWidth, h = window.innerHeight;
    for (const x of [w - 40, 40]) {
      for (let y = 100; y < h - 20; y += 16) {
        for (const e of document.elementsFromPoint(x, y)) {
          if (e.closest('.skifut-item,.skifut-hover,.skifut-dock,.skifut-fab')) continue;
          const text = e.getAttribute('aria-label') || e.getAttribute('data-tooltip') || (e.children.length === 0 ? e.textContent : '') || '';
          if (!text || text.length > 40) continue;
          for (const name of RAIL_ORDER) {
            if (!found[name] && RAIL_NAMES[name].test(text.trim())) found[name] = e;
          }
        }
      }
    }
    return found;
  }

  function findRailAnchor() {
    const found = railItems();
    const name = RAIL_ORDER.find((n) => found[n]);
    if (!name) return null;
    const hit = found[name];
    const others = RAIL_ORDER.filter((n) => n !== name && found[n]).map((n) => found[n]);
    // climb to the whole rail item: the highest ancestor that does not yet hold another rail item
    let el = hit;
    for (let p = el.parentElement; p && p !== document.body; p = el.parentElement) {
      if (others.some((o) => p.contains(o))) break;
      const pr = p.getBoundingClientRect(), er = el.getBoundingClientRect();
      if (pr.width > 140 || pr.height > Math.max(er.height, 40) * 3.5) break;
      el = p;
    }
    return el;
  }

  // Take colours and text size from the rail item above ours, so ours looks exactly like Gmail's own (any theme)
  function syncColors(item) {
    const prev = item.previousElementSibling;
    if (!prev) return;
    let label = null;
    for (const e of prev.querySelectorAll('*')) {
      const t = e.children.length === 0 ? e.textContent.trim() : '';
      if (t.length > 1 && t.length < 20) { label = e; break; }
    }
    let labelColor = '';
    if (label) {
      const cs = getComputedStyle(label);
      labelColor = cs.color;
      item.style.setProperty('--sk-label', cs.color);
      item.style.setProperty('--sk-size', cs.fontSize);
      item.style.setProperty('--sk-weight', cs.fontWeight);
      item.style.setProperty('--sk-family', cs.fontFamily);
    }
    const shape = prev.querySelector('svg path, svg');
    let icon = '';
    if (shape) { const cs = getComputedStyle(shape); icon = cs.fill && cs.fill !== 'none' ? cs.fill : cs.color; }
    else { const g = prev.querySelector('i, [class*="icon"]'); if (g) icon = getComputedStyle(g).color; }
    item.style.setProperty('--sk-icon', icon || labelColor);
  }

  let railFailed = false; // the item landed away from the rail once: use the floating button instead

  // An item that is not at the edge of the window is in the wrong place
  function misplaced(item) {
    const r = item.getBoundingClientRect();
    if (!r.width || !r.height) return false; // not shown yet
    return r.left > 140 && r.right < window.innerWidth - 140;
  }

  let showInGmail = true; // the reader's setting; kept in sync below

  function ensureButton() {
    if (!ctxOk()) return;
    if (!showInGmail) {
      document.getElementById(ITEM_ID)?.remove();
      document.getElementById(FAB_ID)?.remove();
      closeHover();
      closeDock();
      return;
    }
    const existing = document.getElementById(ITEM_ID);
    if (existing) {
      if (misplaced(existing)) { existing.remove(); railFailed = true; } else return;
    }
    const anchor = railFailed ? null : findRailAnchor();
    if (anchor) {
      document.getElementById(FAB_ID)?.remove();
      anchor.after(makeItem(false));
      refreshBadge();
      syncColors(document.getElementById(ITEM_ID));
      setTimeout(ensureButton, 400); // check that it really landed at the rail
    } else if ((railFailed || Date.now() - started > 6000) && !document.getElementById(FAB_ID)) {
      document.body.append(makeItem(true)); // fallback when Gmail's menu is not found
      refreshBadge();
    }
  }

  const isRtl = () => document.dir === 'rtl' || getComputedStyle(document.body).direction === 'rtl';

  function makeFrame(mode) { // mode: 'hover' | 'dock' - the page shows the matching buttons in its own header
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('sidepanel.html?embed=' + mode);
    f.allow = 'clipboard-write'; // the copy buttons inside the window
    return f;
  }

  // the old script of a tab that stayed open while the extension was reloaded must not run
  function cutOff() {
    if (ctxOk()) return false;
    document.getElementById(ITEM_ID)?.remove();
    document.getElementById(FAB_ID)?.remove();
    hover?.remove(); dock?.remove(); hover = dock = null;
    return true;
  }

  // --- quick preview: opens on hover, closes when the mouse leaves ---
  function scheduleHide() { clearTimeout(hoverTimer); hoverTimer = setTimeout(closeHover, 350); }
  function closeHover() { clearTimeout(hoverTimer); if (hover) { hover.remove(); hover = null; } }

  function showHover(anchor) {
    if (cutOff() || dock || hover) return;
    const rect = anchor.getBoundingClientRect();
    const h = Math.min(560, window.innerHeight - 32);
    hover = document.createElement('div');
    hover.className = 'skifut-hover';
    hover.style.height = h + 'px';
    hover.style.top = Math.max(16, Math.min(rect.top - 60, window.innerHeight - h - 16)) + 'px';
    if (isRtl()) hover.style.right = Math.max(8, window.innerWidth - rect.left + 4) + 'px';
    else hover.style.left = Math.min(rect.right + 4, window.innerWidth - 400) + 'px';
    hover.append(makeFrame('hover'));
    hover.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
    hover.addEventListener('mouseleave', scheduleHide);
    document.body.append(hover);
  }

  // --- docked window: stays at the bottom corner, can be minimized (like a chat window) ---
  function closeDock() { if (dock) { dock.remove(); dock = null; } }

  function openDock() {
    if (cutOff()) return;
    closeHover();
    if (dock) return;
    dock = document.createElement('div');
    dock.id = DOCK_ID;
    dock.className = 'skifut-dock';
    dock.append(makeFrame('dock'));
    document.body.append(dock);
  }

  // the window's own header (inside the page) sends these commands
  function toggleMin() {
    if (!dock) return;
    const min = dock.classList.toggle('min');
    dock.querySelector('iframe')?.contentWindow?.postMessage({ src: 'skifut-host', cmd: 'min', value: min }, '*');
  }
  window.addEventListener('message', (e) => {
    if (!ctxOk() || e.origin !== chrome.runtime.getURL('').replace(/\/$/, '')) return;
    const d = e.data;
    if (!d || d.src !== 'skifut') return;
    if (d.cmd === 'dock') openDock();
    else if (d.cmd === 'min') toggleMin();
    else if (d.cmd === 'close') { closeDock(); closeHover(); }
  });

  function toggleDock() {
    if (cutOff()) return;
    if (dock) closeDock(); else openDock();
  }

  document.addEventListener('click', (e) => {
    if (hover && !hover.contains(e.target)) closeHover();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHover(); });

  let t = null;
  new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(ensureButton, 300);
  }).observe(document.body, { childList: true, subtree: true });
  setInterval(() => { ensureButton(); const it = document.getElementById(ITEM_ID); if (it) syncColors(it); }, 3000);

  // tell the background that this tab shows our item: a click on the toolbar icon then opens the docked window here
  const announce = () => { if (ctxOk()) chrome.runtime.sendMessage({ src: 'skifut', cmd: 'gmail-tab', on: showInGmail }).catch(() => {}); };
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.src === 'skifut-bg' && msg.cmd === 'toggleDock') toggleDock();
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.unread) setBadges(ch.unread.newValue || 0);
    if (ch.settings) {
      showInGmail = ch.settings.newValue?.showInGmail !== false;
      ensureButton();
      announce();
    }
  });
  chrome.storage.local.get('settings').then(({ settings }) => {
    showInGmail = settings?.showInGmail !== false;
    ensureButton();
    announce();
  });
  setInterval(announce, 60000); // the background may have restarted and forgotten this tab
})();
