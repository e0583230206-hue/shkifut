# העלאה לשרת

השרת: Ubuntu עם nginx קיים. האתר מתווסף כאתר נפרד, בלי לפגוע באתרים ובשירותים שכבר רצים (אפליקציות Node על 3000/3001, WAHA על 3456).
האפליקציה מאזינה רק ב-`127.0.0.1:8090`, ו-nginx מפנה אליה.

## לפני ההעלאה (פעם אחת)
1. **DNS ב-box.co.il:** רשומת `A` עבור `30206.co.il` ועבור `www.30206.co.il`, שמצביעות ל-`45.93.95.182`. בלי זה HTTPS לא יוגדר, וההתקנה תדלג עליו עם הודעה.
2. **Google:** Client ID ו-Secret לפי [GOOGLE_OAUTH.md](GOOGLE_OAUTH.md). אפשר גם אחרי ההעלאה.
3. **SSH לשרת מהמחשב הזה:** הפקודה `ssh root@45.93.95.182` צריכה לעבוד.

## ההעלאה: פקודה אחת מהמחשב
ב-PowerShell, בתיקיית הפרויקט:
```powershell
.\deploy\upload.ps1
```

הפקודה:
1. אורזת את מה שנמצא ב-git: בלי `.env`, בלי נתונים מקומיים ובלי תעודות נטפרי.
2. מוסיפה את מודלי הטשטוש שכבר נבנו כאן.
3. מעלה ל-`/opt/thechannel` ומריצה את `deploy/install.sh`, שמבצע:
   - בדיקה או התקנה של Docker ו-certbot.
   - יצירת `.env` בהפעלה הראשונה, עם SECRET_KEY אקראי ו-`APP_ENV=production`.
   - הכנת המודלים, כולל מודל הגוף (בשרת אין חסימת נטפרי).
   - בנייה והפעלה של הקונטיינרים: האתר, מסד הנתונים ושירות הטשטוש.
   - קובץ אתר אחד ב-nginx (`/etc/nginx/sites-available/30206.co.il.conf`). לפני טעינה מחדש מורץ `nginx -t`, ואם הבדיקה נכשלת האתר החדש מנוטרל ושום דבר אחר לא משתנה.
   - הגדרת HTTPS עם certbot, כולל הפניה אוטומטית מ-http.
   - גיבוי יומי ב-03:30.

**עדכון גרסה בהמשך:** אותה פקודה בדיוק. הנתונים, ה-`.env` והגדרות ה-nginx נשמרים.

### אפשרות חלופית: התקנה ישירות בשרת
```bash
sudo mkdir -p /opt/thechannel && cd /opt/thechannel   # להעתיק לכאן את קוד הפרויקט
sudo GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... ./deploy/install.sh 30206.co.il e0583230206@gmail.com
```
אפשרויות נוספות:
- `--port 8091`: אם 8090 תפוס.
- `--no-ssl`: דילוג על HTTPS.
- `--force-nginx`: יצירה מחדש של קובץ האתר. הקובץ הקודם נשמר בגיבוי.

## אחרי ההעלאה
1. נכנסים ל-`https://30206.co.il/login` עם החשבון שמוגדר ב-`ADMIN_USERS`.
2. **ניהול ← פרטי ערוץ:** שם "שקיפות", תיאור ולוגו.
3. **ניהול ← הגדרות:**
   - `api_secret_key`: מפתח ארוך ואקראי לגשר מוואטסאפ, לפי [BRIDGE_API.md](BRIDGE_API.md).
   - **רמת החמרה בטשטוש:** ברירת המחדל היא "מחמיר".
4. **הגשר:** מעדכנים אותו לכתובת `https://30206.co.il/api/import/...`.

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
השרת: 4 מעבדים, 8GB זיכרון.
- **שירות הטשטוש:** מוגבל ל-3 מעבדים ול-1.5GB. כך נשאר מקום ל-nginx, ל-Node ול-WAHA.
- **זמן עיבוד:** סרטון של דקה מעובד בערך בדקה וחצי.
- **בזמן העיבוד:** הקוראים רואים את הקובץ מטושטש, עם התווית "בבדיקה".
