# גיבוי חיצוני של האתר (hashkifut.co.il) למחשב

**העיקרון:** המחשב שלך *מושך* מהשרת. השרת לא מגיע אליך, והחשבון שמושך הוא חשבון קריאה בלבד ללא shell, שרואה רק רשימה סגורה של תיקיות.

## מה מגובה ואיפה (במחשב: `D:\shkifut-private`)

| מה | איפה | כמה | תדירות |
|---|---|---|---|
| מסד ההודעות (kvrocks) | `server-backups\db-*.tgz` | 14 עותקים מתוארכים | יומי, 06:30 |
| המדיה המקורית + מטא-דאטה | `media-backup\channel_data` | הכל, מצטבר | יומי, 06:30 |
| עותקים מטושטשים (כולל `manual`) | `media-backup\blurred` | הכל, מצטבר | יומי |
| תיקוני המנחים לאימון, יומן החלטות | `media-backup\training`, `media-backup\logs` | הכל | יומי |
| קבצים שנמחקו או השתנו בשרת | `media-backup\_deleted\<תאריך>\...` | 30 יום | אוטומטי |
| הגדרות הסודות (`.env`, compose, kvrocks.conf) | `secrets-weekly\config-*.tgz` | 4 עותקים | פעם בשבוע |
| קובץ ה-nginx של האתר (כולל קובץ האימות של גוגל, שלא נמצא ב-git) | `secrets-weekly\nginx-*.conf` | 4 עותקים | פעם בשבוע |
| לוגים, דוחות, מצב | `backup-state` | | |

**לא מגובה בכוונה:** ה-session של וואטסאפ (`/opt/bridge/sessions`; אם יאבד, סורקים QR מחדש) וקובצי `.env` בתוך גיבוי המדיה.
**לא מגובה בכלל (צריך לדעת):** `moderation_models` (מורידים מחדש) והתמונות של Docker (בונים מחדש מ-git).

## מה ירוץ ומתי (Task Scheduler, ללא מנהל, כשאתה מחובר ל-Windows)

- `TheChannel backup - daily`, כל יום ב-06:30: מסד, הגדרות (פעם בשבוע), מדיה מצטברת. אם המחשב היה כבוי, ירוץ בהדלקה הבאה.
- `TheChannel backup - first copy`: חד-פעמי (03:00 בלילה שנקבע), שלבים: `channel_data` ← `training` ← `logs` ← `blurred`. נעצר ב-06:20.
- `TheChannel backup - health`: בהתחברות וב-12:00, התראה אם לא היה גיבוי מוצלח 3 ימים.

כל הרצה: עדיפות נמוכה, הגבלת קצב 4MB/s, חיבור אחד לשרת בכמה ערוצים (ראה `common.ps1`), והמחשב לא נרדם בזמן ההעתקה (חוזר לשגרה בסיומה).
**שערים:** שום מדיה לא מועתקת לפני שנוצר הקובץ `D:\shkifut-private\.media-protection-confirmed` (על ידי הבעלים, אחרי שהתיקייה מוצפנת), והתיקייה חייבת להיות פרטית (אף חשבון מקומי אחר לא יכול לקרוא אותה) ולא בתוך OneDrive.

### אישור הצפנה

1. בדיקה בלי מנהל: `Win+R` ← `control /name Microsoft.BitLockerDriveEncryption`, או מנעול על אייקון הכונן. אם D: מוצפן (BitLocker), ממשיכים.
2. אם לא: או שמי שמנהל את המחשב מפעיל BitLocker על D:, או מצפינים את התיקייה בלבד (EFS, בלי מנהל): `cipher /e /s:D:\shkifut-private\media-backup`, ואז **מייצאים את אישור ההצפנה** (`certmgr.msc` ← Personal ← Certificates ← "Encrypting File System" ← Export, עם סיסמה) ושומרים במקום נפרד.
3. אחרי זה, יוצרים את קובץ האישור: `New-Item D:\shkifut-private\.media-protection-confirmed -ItemType File`.

## בדיקת תקינות

```powershell
cd "D:\Users\user\Desktop\עבודה תיכנות\TheChannel-master\deploy\backup-pc"
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-media.ps1 -Full -Sha   # ספירה, גודל, ו-SHA-256 לכל מקור
powershell -NoProfile -ExecutionPolicy Bypass -File .\restore-test-db.ps1          # פותח את גיבוי המסד האחרון ב-kvrocks נקי וסופר הודעות
```

- **SHA-256:** שם כל קובץ מדיה ב-`channel_data` הוא ה-SHA-256 של התוכן שלו, ולכן הסקריפט מחשב ומשווה לשם. אי-התאמה = קובץ פגום. זה בלתי תלוי בכלי ההעתקה ובשרת.
- הדוח נכתב ל-`backup-state\report-<תאריך>.txt`.

## שחזור (שרת חדש או שרת שאבד)

הכל נעשה מהמחשב שלך מול השרת החדש (אחרי שהותקנו Docker ותיקיית `/opt/thechannel` מ-git).

**1. הגדרות** (הסודות; עותק אחרון ב-`secrets-weekly`):
```powershell
scp -i ~/.ssh/thechannel_deploy D:\shkifut-private\secrets-weekly\config-<תאריך>.tgz root@<שרת>:/root/
# בשרת: tar -xzf /root/config-<תאריך>.tgz -C /      (מחזיר .env, compose, kvrocks.conf, wa-site-ids.json למקומם)
```

**2. מסד ההודעות** (עם kvrocks ו-backend עצורים):
```powershell
scp -i ~/.ssh/thechannel_deploy D:\shkifut-private\server-backups\db-<תאריך>.tgz root@<שרת>:/root/
```
```bash
# בשרת
mkdir /root/restore && tar -xzf /root/db-<תאריך>.tgz -C /root/restore        # נוצרת תיקייה backup
V=/var/lib/docker/volumes/thechannel_kvrocks_data/_data
mv $V/db $V/db.old 2>/dev/null; cp -a /root/restore/backup $V/db
cd /opt/thechannel && docker compose -f docker-compose.prod.yml -f docker-compose.bridge-net.yml up -d
docker compose -f docker-compose.prod.yml exec -T redis redis-cli -s /data/kvrocks.sock ZCARD m_times:1   # מספר ההודעות
```

**3. מדיה** (קודם `channel_data`, הקריטי; אחר כך `blurred`):
```powershell
$env:RCLONE_CONFIG_SRV_TYPE='sftp'; $env:RCLONE_CONFIG_SRV_HOST='<שרת>'; $env:RCLONE_CONFIG_SRV_USER='root'
$env:RCLONE_CONFIG_SRV_KEY_FILE="$env:USERPROFILE\.ssh\thechannel_deploy"
rclone copy D:\shkifut-private\media-backup\channel_data SRV:/opt/thechannel/channel_data --ignore-existing --transfers 4 --progress
rclone copy D:\shkifut-private\media-backup\blurred SRV:/var/lib/docker/volumes/thechannel_blurred/_data --ignore-existing --transfers 4 --progress
# בשרת, בעלות כמו קודם:  chown -R 10001 /var/lib/docker/volumes/thechannel_blurred/_data
```
`blurred` ניתן גם לחולל מחדש (טשטוש ידני נשמר כצורות במטא-דאטה), אבל השחזור מהיר יותר. קבצים של הודעות שנמחקו נמצאים ב-`_deleted` ולא משוחזרים אוטומטית.

**4. אימות אחרי שחזור:** `curl` על האתר (200), ספירת הודעות, פתיחת כמה הודעות עם סרטונים/תמונות. את וואטסאפ מחברים מחדש בסריקת QR.

## מה השרת מכיל בשביל זה

- משתמש `shkifut-backup` (קריאה בלבד, `chroot /srv/backup-src`, `internal-sftp -R`, מפתח ייעודי `~/.ssh/thechannel_backup`). חמש תיקיות בלבד, כולן מוצמדות לקריאה בלבד דרך `/etc/fstab`. הוא לא רואה `.env`, את ה-sessions, ולא קובצי הגדרות.
- `deploy/backup-db.sh` (cron 03:30 UTC) שומר 14 ימים; רק קובץ המסד קריא לחשבון הגיבוי, וה-config נשאר 600 root.
- **החזרת הסידור בשרת:** `umount /srv/backup-src/*`, החזרת `/etc/fstab` ו-`/etc/ssh/sshd_config` מהעותקים (`/root/*.before-shkifut-backup`), `userdel -r shkifut-backup`, והחזרת `backup-db.sh`.
