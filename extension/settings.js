// Reader settings, kept in this browser only (chrome.storage.local).
export const DEFAULTS = {
  notify: true,       // popup notifications for new messages
  soundOn: true,      // play a sound with the notification
  sound: 'ding',
  mutedUntil: 0,      // timestamp (ms): no notifications and no sound until then
  font: 's',          // s | m | l (small unless the reader chose another size)
  theme: 'auto',      // auto | light | dark
  showInGmail: true,  // show the "שקיפות" item inside Gmail
};

export async function getSettings() {
  const { settings = {}, notify } = await chrome.storage.local.get(['settings', 'notify']);
  const s = { ...DEFAULTS, ...settings };
  if (settings.notify === undefined && notify !== undefined) s.notify = notify; // from version 0.2
  if (!settings.fontChosen) s.font = DEFAULTS.font; // a size that was only saved as a default is not a choice
  return s;
}

export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: s });
  return s;
}

export const isMuted = (s) => Date.now() < (s.mutedUntil || 0);

export function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}
