# API לגשר מוואטסאפ

הגשר (WAHA וסקריפט Node) מפרסם הודעות בערוץ בשני שלבים: קודם מעלה את המדיה, ואחר כך מפרסם הודעה שמכילה אותה.

## אימות
כל בקשה כוללת את הכותרת `X-API-Key` עם הערך של ההגדרה `api_secret_key`, שמגדירים ב**ניהול ← הגדרות**.
- כדאי לבחור מפתח ארוך ואקראי, למשל 48 תווים.
- כל עוד לא הוגדר מפתח, ה-API סגור ומחזיר 401.

## 1. העלאת מדיה (תמונה, וידאו, אודיו או קובץ)
```
POST /api/import/upload
X-API-Key: <מפתח>
Content-Type: multipart/form-data   (שדה: file)
```
תשובה:
```json
{ "url": "/api/files/1aa8...b3ed.jpg", "filename": "photo.jpg", "filetype": "image" }
```
- `filetype` יכול להיות `image`, `video`, `audio` או סוג אחר.
- **תמונות וסרטונים עוברים בדיקת טשטוש אוטומטית.** עד שהבדיקה מסתיימת הקוראים רואים אותם מטושטשים, ואחר כך הם מתעדכנים מעצמם.
- גודל מקסימלי: לפי ההגדרה `max_file_size` במגה-בייט (ברירת מחדל 100).

## 2. פרסום הודעה
```
POST /api/import/post
X-API-Key: <מפתח>
Content-Type: application/json

{ "text": "...", "author": "WhatsApp" }
```

הטקסט בפורמט Markdown. מדיה משבצים בשורה נפרדת:

| סוג | שורה בטקסט |
|---|---|
| תמונה | `[image-embedded#](<url>)` |
| וידאו | `[video-embedded#](<url>)` |
| אודיו | `[audio-embedded#](<url>)` |
| קובץ | `[שם הקובץ](<url>)` |

**גלריה:** כמה תמונות ברצף, כל אחת בשורה משלה בלי טקסט ביניהן, מוצגות כגלריה אחת: רשת של עד 4 תמונות, עם "+N" כשיש יותר, וצפייה עם מעבר בין התמונות. אלבום מוואטסאפ פשוט שולחים כשורות `[image-embedded#](...)` רצופות.

שדות נוספים:
- `timestamp` (ISO-8601): אופציונלי. אם הוא חסר, או רחוק בעתיד, נשמרת השעה הנוכחית.
- `is_ads`: `true` מסמן הודעת פרסומת.

התשובה היא ההודעה שנשמרה, כולל `id`. ההודעה נשלחת לקוראים מיד, בעדכון חי, וגם להתראות ול-webhook אם הם מוגדרים.

## קודי שגיאה
| קוד | משמעות |
|---|---|
| 401 | מפתח חסר, שגוי, או שלא הוגדר מפתח בערוץ |
| 400 | גוף בקשה לא תקין, או `text` ריק |
| 413 | הקובץ גדול מהמותר |

## דוגמה ב-Node.js (18 ומעלה)
```js
const BASE = 'https://30206.co.il';
const KEY = process.env.CHANNEL_API_KEY;

async function uploadMedia(buffer, filename, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  const res = await fetch(`${BASE}/api/import/upload`, { method: 'POST', headers: { 'X-API-Key': KEY }, body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res.json(); // { url, filename, filetype }
}

async function publish(text, media = []) {
  const lines = media.map(m =>
    m.filetype === 'image' ? `[image-embedded#](${m.url})` :
    m.filetype === 'video' ? `[video-embedded#](${m.url})` :
    m.filetype === 'audio' ? `[audio-embedded#](${m.url})` : `[${m.filename}](${m.url})`);
  const body = { text: [text, ...lines].filter(Boolean).join('\n'), author: 'WhatsApp' };
  const res = await fetch(`${BASE}/api/import/post`, {
    method: 'POST', headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`publish failed: ${res.status}`);
  return res.json();
}

// with WAHA: after downloading a message's media into a buffer
// const m = await uploadMedia(buf, 'photo.jpg', 'image/jpeg'); await publish(caption, [m]);
```

## בדיקה מקומית
`python -I tests/e2e_bridge.py` מריץ את כל התהליך מול http://localhost:8080. המפתח בבדיקה זמני, וההגדרות משוחזרות בסיום.
