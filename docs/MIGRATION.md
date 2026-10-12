# מעבר לשרת חדש ולדומיין חדש

המדריך מתאים למעבר מהדמו (`demo.30206.co.il`, שרת קטן) לשרת או לדומיין אחר, כולל האתר הסופי. כל הנתונים נמצאים בשלושה מקומות בלבד:

| מה | איפה בשרת | מה בו |
|---|---|---|
| מסד הנתונים | volume בשם `thechannel_kvrocks_data` | הודעות, משתמשים והרשאות, הגדרות, נושאים, סקרים, נעיצות, פניות |
| מדיה והגדרות | `/opt/thechannel/channel_data`, `logs`, `training`, `.env` | קבצים שהועלו, יומני טשטוש, נתוני אימון, סודות |
| קוד ומודלים | `/opt/thechannel` | מתעדכן בכל העלאה, ואין בו נתונים |

גרסאות מטושטשות (`blurred`) ומטמון סימן המים נוצרים מחדש, ואין צורך לגבות אותם. הקבצים עצמם נשארים אותו דבר. אחרי המעבר, קבצים בלי גרסה מטושטשת מעובדים מחדש לפי הצורך, וצריך לתת לזה זמן.

## א. מעבר לשרת חדש (אותו דומיין או אחר)

### 1. הכנת השרת החדש
- Ubuntu 22.04 ומעלה, עם nginx, גישת SSH ל-root, ו-DNS שמצביע אליו. אם הדומיין ישתנה, צריך רשומת `A` חדשה לפני שלב 6.
- מומלץ 2 מעבדים ו-4GB זיכרון לפחות. בשרת עם פחות מ-4GB מגבילים את שירות הבדיקה לפי `.env` (`MODERATION_CPUS`, `MODERATION_MEM`, `MODERATION_THREADS`).
- בשרת הישן, לפני הכל: `sudo /opt/thechannel/deploy/backup.sh` (או לוודא שגיבוי מהלילה קיים ב-`/var/backups/thechannel`).

### 2. התקנה נקייה בשרת החדש
במחשב, בתיקיית הפרויקט (אותה פקודה כמו בהעלאה הראשונה):
```powershell
.\deploy\upload.ps1 -Server root@<כתובת השרת החדש> -Domain <הדומיין> -KeyFile $HOME\.ssh\thechannel_deploy
```
זה מתקין אתר ריק, עם `.env` חדש. הוא יוצר SECRET_KEY חדש, וזה נכון: כל המשתמשים יצטרכו להתחבר מחדש, וזה בסדר.

### 3. העברת הגיבוי
מהשרת הישן לחדש (מהמחשב שלך, או ישירות בין השרתים):
```bash
scp root@<ישן>:/var/backups/thechannel/db-<תאריך>.tgz root@<ישן>:/var/backups/thechannel/files-<תאריך>.tgz /tmp/
scp /tmp/db-*.tgz /tmp/files-*.tgz root@<חדש>:/tmp/
```
הגיבוי כולל את `.env` עם הסודות. מעבירים אותו רק בערוץ מוצפן (SSH), ומוחקים את העותקים הזמניים אחר כך.

### 4. שחזור בשרת החדש
```bash
cd /opt/thechannel
sudo docker compose -f docker-compose.prod.yml down                 # עוצר, בלי למחוק נתונים
sudo tar xzf /tmp/files-<תאריך>.tgz -C /opt/thechannel               # channel_data, logs, training ו-.env
sudo docker run --rm -v thechannel_kvrocks_data:/k -v /tmp:/b alpine \
  sh -c 'rm -rf /k/db && mkdir -p /k/db && tar xzf /b/db-<תאריך>.tgz -C /tmp && cp -a /tmp/backup/. /k/db/'
```
**חשוב:** הקובץ `.env` שהוחזר הוא של השרת הישן. מעדכנים בו, לפני ההפעלה:
- `PUBLIC_URL=https://<הדומיין החדש>`
- `APP_PORT` (אם 8090 תפוס בשרת החדש)
- `MODERATION_CPUS` / `MODERATION_MEM` / `MODERATION_THREADS` לפי גודל השרת החדש.
- בדיקה ש-`APP_ENV=production` ושאין `DEV_LOGIN`.

### 5. הפעלה ובדיקה
```bash
sudo docker compose -f docker-compose.prod.yml up -d
curl -s http://127.0.0.1:8090/api/channel/info        # צריך להחזיר את שם הערוץ
```
בודקים בדפדפן (דרך `/etc/hosts` או מיד אחרי עדכון ה-DNS): הודעות, תמונות, וידאו, והתחברות.

### 6. החלפת DNS
1. מורידים את ה-TTL של הרשומה ל-300 שניות, **יום לפני** המעבר.
2. מעדכנים את רשומת ה-`A` לכתובת החדשה ב-box.co.il.
3. אחרי שהדומיין מצביע לשרת החדש: `sudo ./deploy/install.sh <דומיין> <מייל>` מנפיק אישור HTTPS (certbot דורש שה-DNS כבר יצביע לשרת).
4. משאירים את השרת הישן פועל יומיים-שלושה, ומוודאים שהקוראים עברו (אין תעבורה חדשה ביומני nginx שלו). אחר כך מכבים אותו.

## ב. מעבר לדומיין חדש בלבד (אותו שרת)
1. **DNS:** רשומת `A` של הדומיין החדש לשרת.
2. **Google:** בקונסולה, ב-Credentials, מוסיפים ל-Client ID הקיים את `https://<חדש>` ל-JavaScript origins ואת `https://<חדש>/login` ל-redirect URIs. לא מוחקים את הישנים עד שהמעבר הושלם. מוסיפים את הדומיין גם ל-Authorized domains במסך ההסכמה.
3. **בשרת:** ב-`/opt/thechannel/.env` מעדכנים `PUBLIC_URL=https://<חדש>`, ואז:
   ```bash
   cd /opt/thechannel && sudo ./deploy/install.sh <חדש> <מייל>
   sudo docker compose -f docker-compose.prod.yml up -d
   ```
   `install.sh` מוסיף קובץ nginx נפרד לדומיין החדש ומנפיק אישור, בלי לגעת באתרים אחרים.
4. **הפניה מהכתובת הישנה (מומלץ):** ב-`/etc/nginx/sites-available/<ישן>.conf` מחליפים את גוף ה-`location /` ב-`return 301 https://<חדש>$request_uri;`, ואז `sudo nginx -t && sudo systemctl reload nginx`.
5. **הגשר:** מעדכנים את כתובת ה-API בגשר ל-`https://<חדש>/api/import/...`.
6. **קישורים ששותפו:** כתובות `/m/<מספר>` נשארות זהות, ולכן קישור ישן שמופנה לדומיין החדש עובד.

## ג. אתר סגור או פתוח
- **סגור (דמו):** `PRIVATE_SITE=true` ו-`ALLOWED_EMAILS=a@x.com,b@y.com` ב-`.env`. מנהלי `ADMIN_USERS` תמיד מורשים. אחרי שינוי: `sudo docker compose -f docker-compose.prod.yml up -d`.
- **פתיחה לציבור:** מוחקים את שתי השורות האלה (או `PRIVATE_SITE=false` ו-`ALLOWED_EMAILS=`), ומפעילים מחדש. ב-Google מעבירים את האפליקציה ל-In production, כדי ששום חשבון לא יצטרך להיות Test user.

## ד. רשימת בדיקה אחרי כל מעבר
- [ ] `https://<דומיין>/login` נטען עם HTTPS תקין.
- [ ] התחברות עם Google עובדת, והמנהל מקבל הרשאות מנהל.
- [ ] הודעות ישנות, תמונות וסרטונים מוצגים, ותמונה שהייתה מטושטשת עדיין מטושטשת לקורא.
- [ ] פרסום הודעה, תמונה וסרטון: הסרטון עובר בדיקה והופך מ"בדיקה" ל"טשטוש אזורי" או "פתוח".
- [ ] הגשר מפרסם הודעה (בודקים עם `curl` לפי [BRIDGE_API.md](BRIDGE_API.md)).
- [ ] `sudo ./deploy/backup.sh` רץ בהצלחה, וקיים cron ב-`/etc/cron.d/thechannel`.
- [ ] האתרים האחרים בשרת עובדים (בדיקה בדפדפן או `curl -I` לכל אחד).
- [ ] הרצת בדיקת דליפה על סרטון הפגנה: `moderation/tests/run_leak_check.sh`.
