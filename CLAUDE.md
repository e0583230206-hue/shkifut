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

## מצב הדמו (נפרס ב-19.10.2026, מ-`main` נקי בקומיט `001dcb8`)
- כתובת: `demo.30206.co.il` על `45.93.95.182`, תיקייה `/opt/thechannel`, אתר פרטי (`PRIVATE_SITE=true`, `ALLOWED_EMAILS` + `ADMIN_USERS`). מפתח SSH: `~/.ssh/thechannel_deploy`.
- **פריסה:** התמונות נבנות מקומית מ-`main` נקי (`docker compose -f docker-compose.prod.yml build`), ארכיון קוד (`git archive HEAD`) ותמונות (`docker save`) עולים ב-scp, ובשרת `docker load` ואז `docker compose -f docker-compose.prod.yml -f docker-compose.bridge-net.yml up -d --no-build`. את `deploy/install.sh` לא מריצים בעדכון, כי הוא טוען מחדש את nginx.
- **דגלים ב-`.env` של הדמו:** `HOLD_VIDEOS_UNTIL_APPROVED=1`, `STRICT_UNTIL_REVIEWED=1`, `DECISION_V2=1`, `APPROVER_EMAILS=` (ריק: רק הבעלים מאשרים), `BRIDGE_NETWORK=bridge_default`, `BRIDGE_NOTIFY_URL=http://bridge:8080/notify`, `BRIDGE_NOTIFY_KEY` (סוד, לא בגיט), `PUBLIC_URL=https://demo.30206.co.il`.
- **גשר (`/opt/bridge`):** `bridge.js` חדש עם `POST /notify` (רשת Docker בלבד + מפתח `NOTIFY_KEY`), ו-`notify-guard.js` מחובר ב-mount. הגשר לא מפרסם פורט. WAHA לא נגע.
- **החזרה:** גיבוי הגשר ב-`/opt/bridge/backup-hold-20261019-100341` (החזרת הקבצים ו-`docker compose up -d --no-deps bridge`). גיבוי `.env` ב-`/opt/thechannel/backup-hold-20261019-100341`. תמונות קודמות: `thechannel-backend:before-hold-20261019-100341`, `thechannel-moderation:before-hold-20261019-100341` (החזרת התג ל-`latest` ו-`up -d`).
- **תור הבדיקה האוטומטית:** שירות אחד על מעבד אחד, כמה דקות לסרטון. אחרי כל הפעלה מחדש של ה-backend הוא מכניס שוב לתור את כל הקבצים שסומנו "ממתין" (ב-19.10 היו 28, חלקם מאתמול). סרטון חדש עלול לחכות שעות.
- נטפרי חוסם את `demo.30206.co.il` מהמחשב שלי (418), ולכן נכנסים דרך מנהרת SSH (`deploy/tunnel.ps1`) בפורט 8080. **פורט 8080 במחשב הוא לא ה-stack המקומי:** בדיקות מקומיות רצות על 18080 (`tests/docker-compose.port.yml`, `BASE_URL`).
- לדמו אין כניסת פיתוח, ולכן אי אפשר לבדוק שם כקורא בלי להתחבר עם גוגל. את זה עושה הבעלים בדפדפן.

**לפני פתיחה לציבור:** הדגל `HOLD_VIDEOS_UNTIL_APPROVED` כבר דלוק בדמו (הוא נקבע בזמן ההעלאה, ומשפיע רק על סרטונים שהועלו אחרי שהודלק). לא משנים את `PRIVATE_SITE` ולא פותחים לקוראים בלי אישור מפורש.

## ענפים
- `main`: `bf4c004`. עבודה נוכחית ב-`moderation-vote-fix` (7 commits לפני main). אין remote.

## העדפות שלי (איך לעבוד איתי)
- **עברית.**
- **הסברים פשוטים,** בלי ז'רגון מיותר.
- **צעד אחד בכל פעם,** ואז לעצור ולחכות.
- **פקודות מוכנות להעתקה** (בלוק קוד, PowerShell כשמדובר במחשב שלי).
- בסוף כל שלב: דוח קצר בעברית. אם משהו נכשל או לא נבדק, לכתוב זאת במפורש.
- אני לא אדמין במחשב. כונן C ממעט מקום: לא ליצור קבצים גדולים שם.

## הרצה מקומית
`docker compose -f docker-compose.local.yml up -d` ואז http://localhost:8080 (כניסת פיתוח: `/auth/dev-login`, דורש `DEV_LOGIN=true`).
המחשב מאחורי נטפרי MITM: `winget --source winget`, והתעודות ב-`certs/*.crt`.
