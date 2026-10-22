// What the bridge must NOT publish: edits/deletes of WhatsApp messages (they would show up as new posts), the command
// messages "!ערוך" / "!מחק", and the status lines the editing bot answers with. Everything else is published as it is.
// Text is never held for approval; only this noise is dropped.

// Invisible direction marks that WhatsApp / bots put around text.
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const clean = (t) => String(t == null ? '' : t).replace(INVISIBLE, '').trim();

// Events that are not a new message: a plain WhatsApp edit, a revoke (delete for everyone), a reaction, a delivery receipt.
const NOT_NEW_EVENT = /^message\.(edited|revoked|reaction|ack|waiting)$/;

// A command: the first word is exactly !ערוך or !מחק.
const COMMAND = /^!(ערוך|מחק)(\s|$)/;

// The whole line has to be a status line (a normal sentence that only mentions these words is kept).
const STATUS_LINES = [
  /^✅\s*הודעה עודכנה[.!]*$/,
  /^✅\s*הצלחות\s*:\s*\d+$/,
  /^❌\s*שגיאות\s*:\s*\d+$/,
  /^📣\s*ערוצי טלגרם\s*:?$/,
  /^⏳?\s*מעדכן הודעה[.!…]*$/,
  /^לא נמצאה במערכת[.!]*$/,
];

function isStatusLine(line) {
  return STATUS_LINES.some(re => re.test(line));
}

// Returns why the message is dropped, or '' when it is published.
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
