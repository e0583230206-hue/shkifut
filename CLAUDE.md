# CLAUDE.md: TheChannel ("שקיפות")

## מטרת הפרויקט
גרסה שלנו של TheChannel (Go + kvrocks, Angular) לערוץ חדשות בשם "שקיפות", לקהל חרדי מאחורי סינון נטפרי.
גשר וואטסאפ (WAHA + Node) מפרסם לאתר דרך `/api/import/post` ו-`/api/import/upload`.
לב הפרויקט הוא **טשטוש אוטומטי מחמיר של תמונות וסרטונים**: רק מי שזוהה בוודאות כגבר, או מדיה בלי אנשים, נפתחת. כל השאר מטושטש.
הדרישה שלנו היא פרטיות מחמירה (אפס נשים מוצגות), ולכן היא גוברת על שיעור השחרור.

קוד: `backend/` (Go, כולל `moderation.go`), `frontend/` (Angular), `moderation/` (שירות Python, `app/regional.py`), `bridge/`, `deploy/`.
תיעוד: `moderation/README.md` (טשטוש), `PROGRESS.md` (התקדמות), `docs/` (העלאה, גשר, OAuth).

## החלטות מחייבות
- **"לא ברור" נשאר מטושטש** עד שמנחה מאשר ידנית.
- **אין שליחת חיתוכים (crops) של אנשים לשירות חיצוני.** הכל מעובד מקומית או בשרת שלנו.
- **InsightFace הוא לא-מסחרי:** שימוש במדידות מקומיות בלבד, לעולם לא בקוד שנשלח לשרת.
- **אסור לפרוס (deploy) בלי אישור מפורש שלי.** אישור אחד לא חל על פעם הבאה.
- **לא להציע כללי שחרור אוטומטי לפי פנים או גוף.** מודל הפנים מזהה חלק מהנשים כגברים בביטחון 0.99-1.00, ולא נמצא כלל שמשחרר גברים בלי לדלוף נשים. הדרך להפחית טשטוש היא תהליך סקירה אצל מנחים ועוד נתוני תיוג.
- **לא לגעת בשרתים האחרים ב-45.93.95.182** (nginx ב-80/443, אפליקציות Node ב-3000/3001, WAHA ב-127.0.0.1:3456). הדמו הוא רק `/opt/thechannel`, ו-`/opt/bridge` רק במה שאישרתי במפורש.
- **נטפרי:** לא לעקוף חסימות. תמונות עם נשים נחסמות להורדה, ולא מציגים בצ'אט פריימים שעלולים להכיל נשים.
- סודות (`.env`, `certs/`, `channel_data/`, קבצי `client_secret*`) לא נכנסים ל-git.

## מצב הדמו (נפרס ב-19.10.2026; עודכן אחרי הפתיחה, `main` בקומיט `93dceda`)
- כתובת: `demo.30206.co.il` על `45.93.95.182`, תיקייה `/opt/thechannel`, **האתר פתוח (נפתח ב-19.10 באישור): כל חשבון גוגל יכול להתחבר לקריאה בלבד.** `PRIVATE_SITE=false`, `ALLOWED_EMAILS` ריק, והגדרת הניהול `require_auth=1` (כל ה-API והקבצים דורשים התחברות; אנונימי מקבל 401). אפשר לסגור בחזרה עם `bash /root/demo-close.sh` בשרת (שחזור מ-`/opt/thechannel/backup-open-20261019-103903`), ולפתוח שוב עם `bash /root/demo-open.sh`. מפתח SSH: `~/.ssh/thechannel_deploy`.
- **פריסה:** התמונות נבנות מקומית מ-`main` נקי (`docker compose -f docker-compose.prod.yml build`), ארכיון קוד (`git archive HEAD`) ותמונות (`docker save`) עולים ב-scp, ובשרת `docker load` ואז `docker compose -f docker-compose.prod.yml -f docker-compose.bridge-net.yml up -d --no-build`. את `deploy/install.sh` לא מריצים בעדכון, כי הוא טוען מחדש את nginx.
- **דגלים ב-`.env` של הדמו:** `NOINDEX_SITE=1`, `HOLD_VIDEOS_UNTIL_APPROVED=1`, `STRICT_UNTIL_REVIEWED=1`, `DECISION_V2=1`, `APPROVER_EMAILS=` (ריק: רק הבעלים מאשרים), `BRIDGE_NETWORK=bridge_default`, `BRIDGE_NOTIFY_URL=http://bridge:8080/notify`, `BRIDGE_NOTIFY_KEY` (סוד, לא בגיט), `PUBLIC_URL=https://demo.30206.co.il`.
- **גשר (`/opt/bridge`):** `bridge.js` חדש עם `POST /notify` (רשת Docker בלבד + מפתח `NOTIFY_KEY`), ו-`notify-guard.js` מחובר ב-mount. הגשר לא מפרסם פורט. WAHA לא נגע.
- **החזרה:** גיבוי הגשר ב-`/opt/bridge/backup-hold-20261019-100341` (החזרת הקבצים ו-`docker compose up -d --no-deps bridge`). גיבוי `.env` ב-`/opt/thechannel/backup-hold-20261019-100341`. תמונות קודמות: `thechannel-backend:before-hold-20261019-100341`, `thechannel-moderation:before-hold-20261019-100341` (החזרת התג ל-`latest` ו-`up -d`).
- **תור הבדיקה האוטומטית:** שירות אחד על מעבד אחד, כמה דקות לסרטון. אחרי כל הפעלה מחדש של ה-backend הוא מכניס שוב לתור את כל הקבצים שסומנו "ממתין" (ב-19.10 היו 28, חלקם מאתמול). סרטון חדש עלול לחכות שעות.
- **nginx:** הגבלות קצב לאתר הזה בלבד ב-`/etc/nginx/conf.d/thechannel-limits.conf` ושני קבצי snippets (גיבוי: `/root/nginx-backups/nginx-before-limits-20261019-103220.tgz`). לא נוסו בעומס.
- **פריסה אחרונה (22.10.2026, `main` בקומיט `f6eb093`):** לשונית "מחוברים" למנהלים ובורר בהיר/כהה/לפי המערכת. הוחלפה רק תמונת ה-backend (תג להחזרה: `thechannel-backend:before-presence-20261022-093818`, החזרת התג ל-`latest` ו-`up -d --no-deps backend`). ההפעלה מחדש החזירה לתור הבדיקה את כל הקבצים הממתינים (83 לפני הפריסה).
- נטפרי חוסם את `demo.30206.co.il` מהמחשב שלי (418). `deploy/tunnel.ps1` (מנהרת SSH) **לא בשימוש** כרגע, והפורט שלו עבר ל-18081. ה-stack המקומי והבדיקות רצים על **18080** (`BASE_URL`); הבדיקות עוצרות מול כל כתובת לא מקומית, מול `30206.co.il` ומול הפורטים 8080/8081 (`tests/_guard.py`, `tests/ui/guard.mjs`).
- לדמו אין כניסת פיתוח, ולכן אי אפשר לבדוק שם כקורא בלי להתחבר עם גוגל. את זה עושה הבעלים בדפדפן.

**שינוי ב-`PRIVATE_SITE`, ב-`ALLOWED_EMAILS` או ב-`require_auth` רק באישור מפורש.** `HOLD_VIDEOS_UNTIL_APPROVED` נקבע בזמן ההעלאה: הוא משפיע רק על סרטונים שהועלו אחרי שהודלק.

## ענפים
- `main` כולל הכל עד כאן (אין remote). ענפי עבודה קודמים: `moderation-vote-fix`, `hold-videos-until-approved` (מוזגו). `presence-online` ו-`theme-switcher` מוזגו ל-`main` ונפרסו ב-22.10.

## העדפות שלי (איך לעבוד איתי)
- **עברית.**
- **הסברים פשוטים,** בלי ז'רגון מיותר.
- **צעד אחד בכל פעם,** ואז לעצור ולחכות.
- **פקודות מוכנות להעתקה** (בלוק קוד, PowerShell כשמדובר במחשב שלי).
- בסוף כל שלב: דוח קצר בעברית. אם משהו נכשל או לא נבדק, לכתוב זאת במפורש.
- אני לא אדמין במחשב. כונן C ממעט מקום: לא ליצור קבצים גדולים שם.

## הרצה מקומית
`docker compose -f docker-compose.local.yml up -d` ואז http://localhost:18080 (כניסת פיתוח: `/auth/dev-login`, דורש `DEV_LOGIN=true`).
המחשב מאחורי נטפרי MITM: `winget --source winget`, והתעודות ב-`certs/*.crt`.
