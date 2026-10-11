# יצירת התחברות עם Google (Client ID ו-Secret)

המדריך מיועד לאתר בכתובת `https://30206.co.il`. אם הכתובת שונה, יש להחליף אותה בכל מקום במדריך.

## 1. פרויקט ומסך הסכמה
1. נכנסים ל-https://console.cloud.google.com, מתחברים עם חשבון Google של הערוץ ויוצרים פרויקט חדש (למשל `shkifut`).
2. **APIs & Services ← OAuth consent screen** (או **Google Auth Platform ← Branding**):
   - User type: **External**
   - App name: `שקיפות`
   - User support email: כתובת המייל שלך
   - Authorized domains: `30206.co.il`
   - Developer contact: כתובת המייל שלך
3. **Scopes:** רק `email`, `profile` ו-`openid`, שהם ברירת המחדל. אין צורך באימות מצד Google.
4. **Publishing status:** לוחצים **Publish app** (מעבר ל-In production). כל עוד האפליקציה במצב Testing, רק משתמשי בדיקה שהוגדרו יוכלו להתחבר.

## 2. יצירת ה-Client ID
**APIs & Services ← Credentials ← Create credentials ← OAuth client ID**
- Application type: **Web application**
- Name: `shkifut-web`
- **Authorized JavaScript origins:**
  ```
  https://30206.co.il
  ```
- **Authorized redirect URIs** (בדיוק כך, בלי לוכסן בסוף):
  ```
  https://30206.co.il/login
  ```

לוחצים Create, ומעתיקים את **Client ID** ואת **Client secret**.

> הכתובת עם www מופנית אוטומטית לכתובת הראשית (בהגדרות nginx), ולכן אין צורך לרשום אותה.

## 3. הכנסה לשרת
בקובץ `/opt/thechannel/.env` בשרת:
```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
PUBLIC_URL=https://30206.co.il
ADMIN_USERS=e0583230206@gmail.com
```
ואז:
```
cd /opt/thechannel && sudo docker compose -f docker-compose.prod.yml up -d
```

הסוד נשמר רק בשרת, בקובץ `.env`, ולא ב-git.

## 4. בדיקה
1. נכנסים ל-`https://30206.co.il/login` ולוחצים "התחבר". אחרי האישור ב-Google חוזרים לאתר מחוברים.
2. משתמש שמופיע ב-`ADMIN_USERS` מקבל אוטומטית הרשאות מנהל. הרשאות למשתמשים אחרים ניתנות מפאנל הניהול: **ניהול ← משתמשים והרשאות**.

## תקלות נפוצות
| הודעה | הסיבה |
|---|---|
| `redirect_uri_mismatch` | הכתובת ב-Authorized redirect URIs לא זהה בדיוק ל-`https://30206.co.il/login`. |
| `access_denied` / "האפליקציה לא אומתה" | האפליקציה עדיין במצב Testing. צריך ללחוץ Publish app. |
| "התחברות נכשלה, נסה שוב" | Client secret שגוי ב-`.env`, או שהשרת לא הופעל מחדש אחרי העדכון. |
