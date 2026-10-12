# העלאה לשרת

המדריך מתאר את ההעלאה לשרת קיים עם אתרים אחרים. המסלול הנוכחי: דמו סגור ב-`https://demo.30206.co.il`, על `45.93.95.182` (Ubuntu, 2 מעבדים, 2GB זיכרון). האתר מתווסף כאתר נפרד ב-nginx, בלי לפגוע בשירותים שכבר רצים (אפליקציות Node על 3000/3001, WAHA על 3456, הגשר ב-`/opt/bridge`). האפליקציה מאזינה רק ב-`127.0.0.1:8090`, ו-nginx מפנה אליה.

> **שרת קטן:** התמונות נבנות **במחשב שלך** ונשלחות מוכנות. אין בנייה בשרת, כי היא דורשת יותר מ-2GB זיכרון. שירות הבדיקה מוגבל ל-1 מעבד ול-600MB (`MODERATION_CPUS=1`, `MODERATION_MEM=600m`).

## לפני ההעלאה (פעם אחת)
1. **DNS ב-box.co.il:** רשומת `A` עבור `demo.30206.co.il`, שמצביעה ל-`45.93.95.182`. בלי זה HTTPS לא יוגדר, וההתקנה תדלג עליו עם הודעה.
2. **Google:** Client ID ו-Secret לפי [GOOGLE_OAUTH.md](GOOGLE_OAUTH.md), עם שתי כתובות ה-redirect. אפשר גם אחרי ההעלאה.
3. **מפתח SSH, כדי שאפשר יהיה להתחבר בלי סיסמה:** ב-PowerShell, פעם אחת (תקלידו את סיסמת השרת פעם אחת):
   ```powershell
   type $HOME\.ssh\thechannel_deploy.pub | ssh root@45.93.95.182 "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
   ```
   אחר כך הפקודה הזאת צריכה להדפיס `ok` בלי לבקש סיסמה:
   ```powershell
   ssh -i $HOME\.ssh\thechannel_deploy -o IdentitiesOnly=yes root@45.93.95.182 "echo ok"
   ```
   המפתח הפרטי נשאר רק במחשב שלך. כדי לבטל גישה בעתיד: מוחקים את השורה `thechannel-deploy` מ-`~/.ssh/authorized_keys` בשרת.

## ההעלאה: פקודה אחת מהמחשב
ב-PowerShell, בתיקיית הפרויקט:
```powershell
.\deploy\upload.ps1 -Domain demo.30206.co.il -AllowedEmails "<מייל המפתח>" -ModerationCpus 1 -ModerationMem 600m -ModerationThreads 1
```
`-AllowedEmails` הוא החשבון של המפתח. החשבון שלך נכלל אוטומטית דרך `ADMIN_USERS`. האתר סגור כברירת מחדל (`-Private`), גם כשהרשימה ריקה.

הפקודה:
1. בונה את התמונות (האתר ושירות הבדיקה) במחשב, ואורזת אותן עם הקוד שב-git: בלי `.env`, בלי נתונים מקומיים ובלי תעודות נטפרי.
2. מוסיפה את מודלי הטשטוש שכבר קיימים כאן.
3. מעלה ל-`/opt/thechannel`, טוענת את התמונות ומריצה את `deploy/install.sh --prebuilt`, שמבצע:
   - בדיקה או התקנה של Docker ו-certbot.
   - יצירת `.env` בהפעלה הראשונה, עם SECRET_KEY אקראי, `APP_ENV=production` והגדרות האתר הסגור.
   - הכנת המודלים, כולל מודל הגוף (בשרת אין חסימת נטפרי).
   - הפעלת הקונטיינרים: האתר, מסד הנתונים ושירות הטשטוש.
   - **גיבוי מלא של `/etc/nginx` ל-`/root/nginx-backups/`** לפני כל שינוי, ואז קובץ אתר אחד חדש (`/etc/nginx/sites-available/demo.30206.co.il.conf`). לפני טעינה מחדש מורץ `nginx -t`, ואם הבדיקה נכשלת האתר החדש מנוטרל ושום דבר אחר לא משתנה.
   - הגדרת HTTPS עם certbot, כולל הפניה אוטומטית מ-http.
   - גיבוי יומי ב-03:30.

**עדכון גרסה בהמשך:** אותה פקודה בדיוק. הנתונים, ה-`.env` והגדרות ה-nginx נשמרים.

### אפשרות חלופית: התקנה ישירות בשרת
```bash
sudo mkdir -p /opt/thechannel && cd /opt/thechannel   # להעתיק לכאן את קוד הפרויקט
sudo GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... PRIVATE_SITE=true ./deploy/install.sh demo.30206.co.il e0583230206@gmail.com
```
אפשרויות נוספות:
- `--port 8091`: אם 8090 תפוס.
- `--no-ssl`: דילוג על HTTPS.
- `--force-nginx`: יצירה מחדש של קובץ האתר. הקובץ הקודם נשמר בגיבוי.
- `--prebuilt`: התמונות כבר נטענו עם `docker load`, ואין בנייה בשרת.

## אחרי ההעלאה
1. נכנסים ל-`https://demo.30206.co.il/login` עם החשבון שמוגדר ב-`ADMIN_USERS`.
2. **ניהול ← פרטי ערוץ:** שם "שקיפות", תיאור ולוגו.
3. **ניהול ← הגדרות:**
   - `api_secret_key`: מפתח ארוך ואקראי לגשר מוואטסאפ, לפי [BRIDGE_API.md](BRIDGE_API.md).
   - **רמת החמרה בטשטוש:** ברירת המחדל היא "מחמיר".
4. **הגשר:** מעדכנים אותו לכתובת `https://demo.30206.co.il/api/import/...`.

## תפעול
| פעולה | פקודה (בשרת, ב-`/opt/thechannel`) |
|---|---|
| מצב | `sudo docker compose -f docker-compose.prod.yml ps` |
| לוגים | `sudo docker compose -f docker-compose.prod.yml logs -f backend moderation` |
| הפעלה מחדש | `sudo docker compose -f docker-compose.prod.yml restart` |
| גיבוי עכשיו | `sudo ./deploy/backup.sh` (הגיבויים ב-`/var/backups/thechannel`, 7 ימים אחרונים) |
| יומן החלטות טשטוש | `logs/moderation.yaml` |

### שחזור מגיבוי
```bash
cd /opt/thechannel
sudo docker compose -f docker-compose.prod.yml stop backend redis
sudo tar xzf /var/backups/thechannel/files-<תאריך>.tgz -C /opt/thechannel        # מדיה, לוגים ו-.env
sudo docker run --rm -v thechannel_kvrocks_data:/k -v /var/backups/thechannel:/b alpine \
  sh -c 'rm -rf /k/db && mkdir -p /k/db && tar xzf /b/db-<תאריך>.tgz -C /tmp && cp -a /tmp/backup/. /k/db/'
sudo docker compose -f docker-compose.prod.yml up -d
```

## משאבים
- **שרת הדמו (2 מעבדים, 2GB):** שירות הבדיקה מוגבל ל-1 מעבד ול-600MB. סרטון של דקה מעובד בערך בשתי דקות עד שלוש, ובינתיים הקוראים רואים אותו מטושטש עם התווית "בבדיקה". תמונות מעובדות בשניות, בתור נפרד.
- **שרת מומלץ לאתר הסופי (4 מעבדים, 8GB):** ברירות המחדל ב-`docker-compose.prod.yml` (3 מעבדים, 1.5GB).
- **המעבר לשרת או לדומיין אחר:** ראו [MIGRATION.md](MIGRATION.md).
