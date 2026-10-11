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
- [ ] 1. אתר מוכן לייצור
- [ ] 2. רישוי מודלים
- [ ] 3. שיפור הטשטוש
- [ ] סיום: MORNING_REPORT.md ו-ALL_DONE.txt

## הבא בתור
סעיף 1: Google OAuth עם מדריך, dev-login כבוי בייצור, ובדיקת פאנל הניהול.
