// Capture mode: for a short window set by the owner, every WhatsApp message that reaches the bridge (from any chat, also the ones the owner
// sent) goes to the private Google Chat space as TEXT ONLY, and NEVER to the site (not even from the channel's group).
//
// The window is a file with the end time (epoch milliseconds):   echo $(( ($(date +%s) + 600) * 1000 )) > /opt/bridge/media/capture-until
// It ends by itself (nothing to switch off), a time further than MAX_WINDOW_MS ahead is ignored (a typo cannot leave it open), and a missing or
// unreadable file means "off". Nothing of a message is written to the log, only that one was forwarded.
const fs = require('fs');

const MAX_WINDOW_MS = 30 * 60 * 1000;
const MAX_TEXT = 3500;

function captureUntil(file, now = Date.now(), fsImpl = fs) {
  let t;
  try { t = Number(String(fsImpl.readFileSync(file, 'utf8')).trim()); } catch { return 0; }
  if (!Number.isInteger(t) || t <= now || t > now + MAX_WINDOW_MS) return 0;
  return t;
}

const digits = (s) => String(s || '').replace(/@.*$/, '').replace(/\D/g, '');

// The line sent to the Chat. Media is never carried over: only its kind.
function captureLine(p) {
  const chatId = String((p.fromMe ? p.to : p.from) || '');
  if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) return '';
  const pushName = p._data && p._data.Info && p._data.Info.PushName;
  const who = p.fromMe ? 'אני' : (pushName || digits(p.participant || p.author || p.from) || 'לא ידוע');
  const where = chatId.endsWith('@g.us') ? 'קבוצה ' + chatId.replace(/@.*$/, '').slice(-4) : (p.fromMe ? 'אל ' + (digits(chatId) || 'שיחה') : 'שיחה אישית');
  const text = String(p.body || '').trim();
  const media = p.hasMedia ? '[מדיה' + (p.media && p.media.mimetype ? ': ' + String(p.media.mimetype).split(';')[0] : '') + ' - לא נשלחה]' : '';
  if (!text && !media) return '';
  const body = [text, media].filter(Boolean).join('\n');
  return '💬 ' + who + ' › ' + where + '\n' + (body.length > MAX_TEXT ? body.slice(0, MAX_TEXT - 1) + '…' : body);
}

module.exports = { captureUntil, captureLine, MAX_WINDOW_MS };
