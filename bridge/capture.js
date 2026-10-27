// Capture mode: every WhatsApp message of a chat that is NOT the channel's group (also the ones the owner sent) goes to the private Google Chat
// space (text, and the ORIGINAL file of a picture / video / voice message / document, as an attachment), and NEVER to the site: nothing of these
// chats is uploaded to the site, so nothing of it is checked or blurred. The channel's group is not touched: it goes on exactly as always.
//
// Two ways to switch it on (the owner decides; nothing happens without one of them):
//   - a window that ends by itself: a file with the end time (epoch milliseconds)
//       echo $(( ($(date +%s) + 600) * 1000 )) > /opt/bridge/media/capture-until
//     (a time further than MAX_WINDOW_MS ahead is ignored: a typo cannot leave it open)
//   - open until the owner closes it: the file  /opt/bridge/media/capture-all  exists   (touch / rm)
// A missing or unreadable file means "off". Nothing of a message is written to the log, only that one was forwarded.
const fs = require('fs');

const MAX_WINDOW_MS = 30 * 60 * 1000;
const MAX_TEXT = 3500;

function captureUntil(file, now = Date.now(), fsImpl = fs) {
  let t;
  try { t = Number(String(fsImpl.readFileSync(file, 'utf8')).trim()); } catch { return 0; }
  if (!Number.isInteger(t) || t <= now || t > now + MAX_WINDOW_MS) return 0;
  return t;
}

// On = the "open" file exists, or the window has not ended.
function captureOn(untilFile, allFile, now = Date.now(), fsImpl = fs) {
  try { if (fsImpl.existsSync(allFile)) return 'all'; } catch { /* unreadable: look at the window */ }
  return captureUntil(untilFile, now, fsImpl) ? 'window' : '';
}

const digits = (s) => String(s || '').replace(/@.*$/, '').replace(/\D/g, '');

// The line sent to the Chat (or the caption of the file sent with it). `mediaState`: 'sent' = the file travels with this message (no note),
// 'failed' = it could not be fetched / uploaded, anything else = only its kind is noted (a digest of the history carries no files).
function captureLine(p, mediaState) {
  const chatId = String((p.fromMe ? p.to : p.from) || '');
  if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) return '';
  const pushName = p._data && p._data.Info && p._data.Info.PushName;
  const who = p.fromMe ? 'אני' : (pushName || digits(p.participant || p.author || p.from) || 'לא ידוע');
  const where = chatId.endsWith('@g.us') ? 'קבוצה ' + chatId.replace(/@.*$/, '').slice(-4) : (p.fromMe ? 'אל ' + (digits(chatId) || 'שיחה') : 'שיחה אישית');
  const text = String(p.body || '').trim();
  const kind = p.media && p.media.mimetype ? ': ' + String(p.media.mimetype).split(';')[0] : '';
  const media = p.hasMedia && mediaState !== 'sent' ? '[מדיה' + kind + (mediaState === 'failed' ? ' - ההעלאה לצ׳אט נכשלה' : ' - לא נשלחה') + ']' : '';
  if (!text && !media && !(p.hasMedia && mediaState === 'sent')) return '';
  const body = [text, media].filter(Boolean).join('\n');
  return '💬 ' + who + ' › ' + where + '\n' + (body.length > MAX_TEXT ? body.slice(0, MAX_TEXT - 1) + '…' : body);
}

module.exports = { captureUntil, captureOn, captureLine, MAX_WINDOW_MS };
