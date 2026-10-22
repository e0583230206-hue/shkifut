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
