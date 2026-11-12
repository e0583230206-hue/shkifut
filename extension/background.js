import { fetchMessages, plain, messageUrl } from './common.js';
import { getSettings, isMuted } from './settings.js';

const ALARM = 'poll';

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 1 }));

// --- click on the toolbar icon ---
// In a Gmail tab (that shows our item) it opens the docked window inside Gmail; everywhere else it opens Chrome's side panel.
// The Gmail tabs announce themselves, so the choice is made at once (the side panel must open straight from the click).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
const gmailTabs = new Set();
chrome.storage.session.get('gmailTabs').then(({ gmailTabs: l = [] }) => l.forEach((id) => gmailTabs.add(id))).catch(() => {});
const saveTabs = () => chrome.storage.session.set({ gmailTabs: [...gmailTabs] }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.src === 'skifut' && msg.cmd === 'gmail-tab' && sender.tab) {
    if (msg.on) gmailTabs.add(sender.tab.id); else gmailTabs.delete(sender.tab.id);
    saveTabs();
  }
});
chrome.tabs.onRemoved.addListener((id) => { if (gmailTabs.delete(id)) saveTabs(); });

chrome.action.onClicked.addListener((tab) => {
  if (gmailTabs.has(tab.id)) {
    chrome.tabs.sendMessage(tab.id, { src: 'skifut-bg', cmd: 'toggleDock' }).catch(() => {
      gmailTabs.delete(tab.id); // the page is gone or was reloaded: fall back to the side panel next time
      chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    });
  } else {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) poll();
});

// A service worker cannot play audio, so a hidden page does it.
async function playSoundOffscreen(sound) {
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'צליל התראה להודעה חדשה',
      });
      await new Promise((r) => setTimeout(r, 300));
    }
    chrome.runtime.sendMessage({ type: 'skifut-play', sound });
  } catch (e) { /* no sound is not an error worth stopping for */ }
}

async function poll() {
  const { lastId } = await chrome.storage.local.get('lastId');
  const s = await getSettings();
  const r = await fetchMessages(50, 0, true); // exact counter up to 50 new messages; marked as a background check (no view is counted)
  await chrome.storage.local.set({ lastStatus: r.status, lastCheck: Date.now() });
  if (!r.ok || !r.messages.length) return;

  const maxId = r.messages[0].id;
  if (lastId === undefined) { // first run: remember the newest, do not flood
    await chrome.storage.local.set({ lastId: maxId, seenId: maxId, unread: 0 });
    return;
  }
  // Unread counter (shown in Gmail and on the toolbar icon): messages newer than the last one the reader saw.
  const { seenId = maxId } = await chrome.storage.local.get('seenId');
  const unread = r.messages.filter((m) => m.id > seenId).length;
  await chrome.storage.local.set({ unread });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setBadgeText({ text: unread ? String(unread > 99 ? '99+' : unread) : '' });

  const fresh = r.messages.filter((m) => m.id > lastId).reverse(); // oldest first
  if (!fresh.length) return;
  await chrome.storage.local.set({ lastId: maxId });
  if (!s.notify || isMuted(s)) return;

  // At most 3 notifications per round; the rest are summed up in one.
  for (const m of fresh.slice(0, 3)) {
    chrome.notifications.create(`m${m.id}`, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'שקיפות',
      message: plain(m.text, 180) || 'הודעה חדשה (מדיה). לצפייה באתר',
      silent: s.soundOn, // our own sound replaces the system one
    });
  }
  if (fresh.length > 3) {
    chrome.notifications.create(`more${maxId}`, {
      type: 'basic', iconUrl: 'icon128.png', title: 'שקיפות', message: `ועוד ${fresh.length - 3} הודעות חדשות`, silent: s.soundOn,
    });
  }
  if (s.soundOn) playSoundOffscreen(s.sound);
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (id.startsWith('m')) chrome.tabs.create({ url: await messageUrl(id.slice(1)) });
  chrome.notifications.clear(id);
});
