// node --test bridge/message-filter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { skipReason } = createRequire(import.meta.url)('./message-filter.js');

const text = (body, event = 'message.any', payload = {}) => skipReason(event, payload, body);

test('status lines of the editing bot are dropped', () => {
  for (const t of ['✅ הודעה עודכנה!', '✅ הצלחות: 3', '❌ שגיאות: 1', '❌ שגיאות: 0', '📣 ערוצי טלגרם', '⏳ מעדכן הודעה', 'מעדכן הודעה', 'לא נמצאה במערכת'])
    assert.notEqual(text(t), '', t);
});

test('a multi-line status report is dropped as a whole', () => {
  assert.equal(text('✅ הצלחות: 3\n❌ שגיאות: 0'), 'bot status');
  assert.equal(text('📣 ערוצי טלגרם\n✅ הצלחות: 2\n❌ שגיאות: 1'), 'bot status');
});

test('the wrong-format answer of the bot (real text of message 1192) is dropped, but not when real text comes with it', () => {
  assert.equal(text('❌ פורמט שגוי!\n\nשימוש נכון:\n!ערוך ***תוכן חדש***'), 'bot status');
  assert.equal(text('❌ פורמט שגוי!\n\nשימוש נכון:\n!מחק'), 'bot status');
  assert.equal(text('‏❌️ פורמט שגוי!\n\nשימוש נכון:\n!ערוך ***תוכן חדש***'), 'bot status');
  assert.equal(text('❌ פורמט שגוי!\nוגם חדשות אמיתיות'), '');
  assert.equal(text('שימוש נכון: קראו את ההוראות'), '');
});

test('!ערוך and !מחק are dropped, also with direction marks and extra text', () => {
  for (const t of ['!ערוך 123 טקסט חדש', '!מחק 123', '!מחק', '!ערוך', '‏!מחק 123', '  !מחק 7'])
    assert.equal(text(t), 'command', t);
});

test('ordinary text that only mentions those words is published', () => {
  for (const t of ['הודעה עודכנה אחרי הפגישה, תודה', 'הערוץ ערוצי טלגרם הוא אחד מכמה', 'סיימנו בהצלחה', 'מחק את זה מהרשימה', 'ערוך את הקובץ', '!חדשות עכשיו', '!מחקנו את הכול',
    '✅ הצלחות: 3\nוגם חדשות אמיתיות', 'שגיאות: 1 בכביש', ''])
    assert.equal(text(t), '', t);
});

test('a plain WhatsApp edit / delete / reaction / receipt is not a new message', () => {
  for (const e of ['message.edited', 'message.revoked', 'message.reaction', 'message.ack'])
    assert.notEqual(text('חדשות', e), '', e);
  assert.equal(text('חדשות', 'message'), '');
  assert.equal(text('חדשות', 'message.any'), '');
});

test('an edit marker on the payload is enough, whatever the event name', () => {
  assert.notEqual(text('חדשות', 'message.any', { editedMessageId: 'abc' }), '');
  assert.notEqual(text('', 'message.any', { revokedMessageId: 'abc' }), '');
});

test('missing event, payload and body do not throw', () => {
  assert.equal(skipReason(undefined, undefined, undefined), '');
  assert.equal(skipReason(null, null, null), '');
});

// ---- the real texts the editing bot posted (25.10.2026, plain text, ordinary spaces, no hidden characters)
const REAL_PROGRESS = '⏳ מעדכן הודעה ב-3 קבוצות ו-1 ערוצי טלגרם...';
const REAL_REPORT = '✅ הודעה עודכנה!\n\n✅ הצלחות: 3\n❌ שגיאות: 0\n📣 ערוצי טלגרם: 1/1';
// the shape of the webhook payload of those two (WAHA, GOWS): not fromMe, a participant of the group, source "app"
const REAL_PAYLOAD = { fromMe: false, from: '120363429217173923@g.us', participant: '106953342742588@lid', source: 'app', hasMedia: false };

test('the two real bot messages of 25.10.2026 are dropped', () => {
  assert.equal(text(REAL_PROGRESS, 'message.any', REAL_PAYLOAD), 'bot status');
  assert.equal(text(REAL_REPORT, 'message.any', REAL_PAYLOAD), 'bot status');
});

test('the same texts are dropped when fromMe, and for the plain "message" event', () => {
  assert.equal(text(REAL_PROGRESS, 'message.any', { ...REAL_PAYLOAD, fromMe: true }), 'bot status');
  assert.equal(text(REAL_REPORT, 'message.any', { ...REAL_PAYLOAD, fromMe: true }), 'bot status');
  assert.equal(text(REAL_REPORT, 'message', REAL_PAYLOAD), 'bot status');
});

test('other counts and forms of the progress line and of the channels line', () => {
  for (const t of ['⏳ מעדכן הודעה ב-1 קבוצה', '⏳ מעדכן הודעה ב-12 קבוצות ו-2 ערוצי טלגרם…',
    '⏳ מעדכן הודעה ב-3 קבוצות ו-1 ערוץ טלגרם...', '⏳ מעדכן הודעה...',
    '📣 ערוצי טלגרם: 0/2', '📣 ערוצי טלגרם: 2 / 2'])
    assert.equal(text(t), 'bot status', t);
});

test('hidden characters and look-alikes do not hide the status text', () => {
  const variants = [
    REAL_PROGRESS.replace('⏳', '⏳️'),                  // emoji variation selector
    '‏' + REAL_PROGRESS,                                          // right-to-left mark in front
    REAL_PROGRESS.replace(/ /g, ' '),                             // no-break spaces
    REAL_PROGRESS.replace('ב-3', 'ב־3'),                // maqaf instead of the hyphen
    REAL_PROGRESS.replace('מעדכן', '​מעדכן'), // zero-width space inside
    REAL_REPORT.replace(/\n/g, '\r\n'),                                // Windows line ends
    REAL_REPORT.split('\n').map(l => (l ? '‎' + l + '‏' : l)).join('\n'),   // marks around every line
    REAL_REPORT.replace('✅', '✅️'),
  ];
  for (const v of variants) assert.equal(text(v), 'bot status', JSON.stringify(v));
});

test('real news is still published, also from the editing bot\'s own account, and also when it only starts like a status line', () => {
  const news = ['✅ הצלחות: 3 החיילים חזרו בשלום',          // starts like a status line, goes on as a sentence
    'מעדכן הודעה ב-3 קבוצות את האזור הבא',
    '📣 ערוצי טלגרם: 1/1 הוקמו היום',
    'חדשות מהארץ: רוב הכבישים פתוחים'];
  for (const t of news) {
    assert.equal(text(t, 'message.any', REAL_PAYLOAD), '', t);
    assert.equal(text(t, 'message.any', { ...REAL_PAYLOAD, fromMe: true }), '', t);
  }
});

test('a command with hidden characters is still a command', () => {
  for (const t of ['‎!מחק 5', '‫!ערוך 5 טקסט‬', '﻿!מחק'])
    assert.equal(text(t), 'command', JSON.stringify(t));
});
