# יצירת התחברות עם Google (Client ID ו-Secret)

המדריך כתוב לאתר הדמו `https://demo.30206.co.il` ולהרצה המקומית `http://localhost:18080`. **אותו Client ID משרת את שניהם.**
כשתעברו לדומיין אחר, מוסיפים לו כתובת נוספת באותו Client ID (ראו "מעבר לדומיין חדש" בסוף).

## 1. פרויקט ומסך הסכמה
1. נכנסים ל-https://console.cloud.google.com, מתחברים עם חשבון Google של הערוץ ויוצרים פרויקט חדש (למשל `shkifut`).
2. **APIs & Services ← OAuth consent screen** (או **Google Auth Platform ← Branding**):
   - User type: **External**
   - App name: `שקיפות`
   - User support email: כתובת המייל שלך
   - Authorized domains: `30206.co.il`
   - Developer contact: כתובת המייל שלך
3. **Scopes:** רק `email`, `profile` ו-`openid`, שהם ברירת המחדל. אין צורך באימות מצד Google.
4. **Publishing status, שתי אפשרויות:**
   - **Testing (מתאים לדמו הסגור):** ב-**Test users** מוסיפים את המיילים שלך ושל המפתח. רק הם יוכלו להתחבר. אין מגבלת זמן על החשבונות, אבל Google מבטלת אישור התחברות כל 7 ימים, ולכן נדרש להתחבר מחדש אחת לשבוע.
   - **In production:** לוחצים **Publish app**. אז כל חשבון Google יכול להגיע למסך ההתחברות, והאתר עצמו עדיין חוסם כל מי שאינו ברשימה (`ALLOWED_EMAILS`).

## 2. יצירת ה-Client ID
**APIs & Services ← Credentials ← Create credentials ← OAuth client ID**
- Application type: **Web application**
- Name: `shkifut-web`
- **Authorized JavaScript origins:**
  ```
  https://demo.30206.co.il
  http://localhost:18080
  ```
- **Authorized redirect URIs** (בדיוק כך, בלי לוכסן בסוף):
  ```
  https://demo.30206.co.il/login
  http://localhost:18080/login
  ```

לוחצים Create, ומעתיקים את **Client ID** ואת **Client secret**.

> Google מרשה `http://localhost` בלי HTTPS. כתובת IP או דומיין אחר ב-HTTP לא יתקבלו.

## 3. הכנסה
**בשרת**, בקובץ `/opt/thechannel/.env`:
```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
PUBLIC_URL=https://demo.30206.co.il
ADMIN_USERS=e0583230206@gmail.com
ALLOWED_EMAILS=<המייל של המפתח>
```
ואז:
```
cd /opt/thechannel && sudo docker compose -f docker-compose.prod.yml up -d
```

**במחשב שלך**, בקובץ `.env` בתיקיית הפרויקט (אותם ערכים, בלי `PUBLIC_URL`), ואז:
```
docker compose -f docker-compose.local.yml up -d
```
כניסה עם Google תעבוד בכתובת http://localhost:18080/login (רק אם הכתובת הזאת רשומה בקונסולת Google; רישום ישן של `localhost:8080` אינו נחוץ עוד). הכניסה המהירה `/auth/dev-login` נשארת זמינה מקומית.

הסוד נשמר רק בקבצי `.env`, ולא ב-git.

## 4. בדיקה
1. נכנסים ל-`https://demo.30206.co.il/login` ולוחצים "התחבר". אחרי האישור ב-Google חוזרים לאתר מחוברים.
2. משתמש שמופיע ב-`ADMIN_USERS` מקבל אוטומטית הרשאות מנהל. הרשאות למשתמשים אחרים ניתנות מפאנל הניהול: **ניהול ← הרשאות**.
3. חשבון שאינו ב-`ADMIN_USERS` או ב-`ALLOWED_EMAILS` מקבל "החשבון הזה לא מורשה להיכנס לאתר".

## תקלות נפוצות
| הודעה | הסיבה |
|---|---|
| `redirect_uri_mismatch` | הכתובת ב-Authorized redirect URIs לא זהה בדיוק לכתובת האתר ועוד `/login`. שימו לב ל-`http` מול `https` ולכתובת מקומית עם הפורט `:18080`. |
| `access_denied` / "האפליקציה לא אומתה" | האפליקציה במצב Testing והחשבון לא מופיע ב-Test users, או שפג תוקף ההתחברות של 7 הימים. |
| "התחברות נכשלה, נסה שוב" | Client secret שגוי ב-`.env`, או שהשרת לא הופעל מחדש אחרי העדכון. |
| "החשבון הזה לא מורשה" | החשבון לא ברשימת `ADMIN_USERS` / `ALLOWED_EMAILS`. אחרי שינוי ברשימה צריך להפעיל את ה-backend מחדש. |

## מעבר לדומיין חדש
ב-Credentials, פותחים את אותו Client ID ומוסיפים (בלי למחוק את הקיימים): Authorized JavaScript origin `https://<הדומיין החדש>` ו-Authorized redirect URI `https://<הדומיין החדש>/login`. מוסיפים את הדומיין גם ל-Authorized domains במסך ההסכמה. ראו [MIGRATION.md](MIGRATION.md).
