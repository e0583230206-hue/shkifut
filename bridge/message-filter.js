// What the bridge must NOT publish: edits/deletes of WhatsApp messages (they would show up as new posts), the command
// messages "!ערוך" / "!מחק", and the status lines the editing bot answers with. Everything else is published as it is.
// Text is never held for approval; only this noise is dropped.

// Characters that WhatsApp / bots put in text without being visible: direction marks and embeddings, zero-width characters, the soft hyphen,
// the combining grapheme joiner and emoji variation selectors (U+FE0E / U+FE0F).
const INVISIBLE = /[­͏​-‏‪-‮⁠-⁤⁦-⁩︎️﻿]/g;
// Look-alikes that break an exact comparison: spaces that are not a plain space (no-break, thin, ideographic ...) and dashes that are not "-"
// (maqaf, hyphen / en / em dash, minus).
const ODD_SPACES = /[   -   　]/g;
const ODD_DASHES = /[־‐-―−]/g;
const clean = (t) => String(t == null ? '' : t).normalize('NFC').replace(INVISIBLE, '').replace(ODD_SPACES, ' ').replace(ODD_DASHES, '-').trim();

// Events that are not a new message: a plain WhatsApp edit, a revoke (delete for everyone), a reaction, a delivery receipt.
const NOT_NEW_EVENT = /^message\.(edited|revoked|reaction|ack|waiting)$/;

// A command: the first word is exactly !ערוך or !מחק.
const COMMAND = /^!(ערוך|מחק)(\s|$)/;

// The whole line has to be a status line (a normal sentence that only mentions these words is kept).
// The editing bot's real texts (posted to the site on 25.10.2026, as plain text with ordinary spaces):
//   "⏳ מעדכן הודעה ב-3 קבוצות ו-1 ערוצי טלגרם..."
//   "✅ הודעה עודכנה!" / "✅ הצלחות: 3" / "❌ שגיאות: 0" / "📣 ערוצי טלגרם: 1/1"
// and its answer to a command with a wrong format (posted 26.10.2026, message 1192), three lines:
//   "❌ פורמט שגוי!" / "שימוש נכון:" / "!ערוך ***תוכן חדש***"
// The progress line carries the number of groups and channels, so those parts are optional and the numbers are free.
const STATUS_LINES = [
  /^✅\s*הודעה עודכנה[.!]*$/,
  /^✅\s*הצלחות\s*:\s*\d+$/,
  /^❌\s*שגיאות\s*:\s*\d+$/,
  /^📣\s*ערוצי טלגרם\s*:?\s*(\d+\s*\/\s*\d+)?$/,
  /^⏳?\s*מעדכן הודעה(\s+ב-?\d+\s+קבוצ(ה|ות))?(\s+ו-?\d+\s+ערוצי טלגרם|\s+ו-?\d+\s+ערוץ טלגרם)?\s*[.!…]*$/,
  /^לא נמצאה במערכת[.!]*$/,
  /^❌\s*פורמט שגוי[.!]*$/,
  /^שימוש נכון\s*:?$/,
  /^!(ערוך|מחק)(\s+[*_~]*תוכן חדש[*_~]*)?$/,
];

function isStatusLine(line) {
  return STATUS_LINES.some(re => re.test(line));
}

// Returns why the message is dropped, or '' when it is published. The sender does not matter (the editing bot's account may also
// distribute real news), and neither does fromMe: only the event, the edit markers and the text decide.
function skipReason(event, payload, body) {
  if (NOT_NEW_EVENT.test(String(event || ''))) return 'event ' + event;
  const p = payload || {};
  if (p.editedMessageId || p.revokedMessageId) return 'edit/revoke marker';
  const text = clean(body);
  if (COMMAND.test(text)) return 'command';
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  if (lines.length && lines.every(isStatusLine)) return 'bot status';
  return '';
}

module.exports = { skipReason, clean };
