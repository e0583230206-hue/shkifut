# התקדמות: עבודת לילה לפי NIGHT_PLAN.md

עודכן: 2026-10-11, לפני תחילת הלולאה.

## מצב נוכחי (מה כבר קיים)
- הרצה מקומית: `docker compose -f docker-compose.local.yml up -d`, ואז http://localhost:8080. הכניסה למנהל בפיתוח: `/auth/dev-login` (`DEV_LOGIN=true` ב-.env).
- מערכת טשטוש אזורית:
  - קבצים: `moderation/app/` (`analyzer.py`, `regional.py`, `server.py`), `backend/moderation.go`, `frontend/src/app/services/media-moderation.service.ts`.
  - רמות החמרה (מחמיר / רגיל / מקל), כפתור "בדוק מחדש", וכפתורי "פתח לכולם" / "טשטוש אזורי" / "טשטוש מלא".
  - בדיקות וסקריפטי עזר: בתיקיית ה-scratchpad של סשן קודם, `tests/run_regional.py` (בדיקת דליפה על כל פריים) ו-`tests/spot.py`. כדאי להעביר אותם לתוך הפרויקט, ל-`moderation/tests/`.
  - תיעוד: `moderation/README.md`.
- מודל גוף (OpenVINO person-attributes-recognition-crossroad-0230, Apache-2.0): הקוד מוכן, אבל נטפרי חוסם את קובץ ה-.bin. התקנה: `python moderation/fetch_body_model.py <xml> <bin>`.
- רישוי: InsightFace (מודלי פנים) לא-מסחרי. YOLOv8 תחת AGPL.

## אילוצים שחייבים לזכור
- נטפרי: לא לעקוף חסימות. תמונות עם נשים נחסמות להורדה. אין להציג בצ'אט פריימים שעלולים להכיל נשים.
- לא לגעת בשרת 45.93.95.182.
- סודות: `.env`, `certs/` ו-`channel_data/` ב-.gitignore.

## שלבים
- [x] שלב א: NIGHT_PLAN.md, PROGRESS.md, run-night.ps1. הלולאה לא הופעלה: הפעלה אוטומטית של סוכן לא-מפוקח נחסמה, וממתינה להחלטת המשתמש.
- [ ] 1. אתר מוכן לייצור: הגנות ייצור וחבילת העלאה בוצעו. נשארו: ניהול, פרסומות, צור קשר, SEO, עמודים, API לגשר, ניקוי מדיה, בדיקות
- [ ] 2. רישוי מודלים
- [ ] 3. שיפור הטשטוש
- [ ] סיום: MORNING_REPORT.md ו-ALL_DONE.txt

## יומן ביצוע (לילה)
- `09c9ca3` **הגנות ייצור.** במצב `APP_ENV=production` השרת מסרב לעלות עם DEV_LOGIN או עם SECRET_KEY קצר (שני המקרים נבדקו). נוספו cookie עם Secure ו-SameSite=Lax, כותרות אבטחה (נבדקו), ו-`PUBLIC_URL` לכתובת ה-redirect של Google. kvrocks מקובע לגרסה 2.17.0 גם מקומית וגם בייצור.
- **חבילת העלאה:**
  - `deploy/install.sh` ו-`deploy/backup.sh`: עברו shellcheck.
  - `deploy/nginx-site.conf.template`: עבר `nginx -t`, כולל הפניית www לכתובת הראשית.
  - `deploy/upload.ps1`: פקודה אחת מהמחשב.
  - `docs/DEPLOY.md` ו-`docs/GOOGLE_OAUTH.md`.
  - הגיבוי נבדק מול ה-stack המקומי, והשחזור נבדק ל-volume זמני: הנתונים זהים.
  - תוקנה שגיאת תחביר ב-`run-night.ps1` (`$round:`).

- **API לגשר:**
  - תוקן באג קיים: הודעה בלי `timestamp` נשמרה עם התאריך 0001-01-01.
  - הודעה מהגשר שולחת עכשיו webhook ו-push כמו הודעה רגילה.
  - טקסט ריק מחזיר 400, ומפתח שגוי מחזיר 401.
  - תיעוד: `docs/BRIDGE_API.md`, עם דוגמת Node.
  - בדיקה: `tests/e2e_bridge.py`, 9/9 עברו.

## הבא בתור
1. בדיקת פאנל הניהול (פרטים, הגדרות, הרשאות, דיווחים, סטטיסטיקות).
3. צור קשר: טופס, פניות בניהול, הגנה מספאם.
4. SEO: כותרת, sitemap, robots, עמוד להודעה בודדת. עמודי פרטיות, תנאים ו-404.
5. פרסומות: תדירות והפעלה/כיבוי.
6. ניקוי מדיה יתומה.
