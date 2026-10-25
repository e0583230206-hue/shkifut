# פריסת הטשטוש הידני (MANUAL_BLUR) לשרת החי: תוכנית

**סטטוס: תוכנית בלבד. לא בוצעה. לא מריצים אותה בלי "פרוס" מפורש.** שרת: `83.229.70.68` (`/opt/thechannel`). לא נוגעים בשרת הישן, בגשר, ב-WAHA ובבוט של ימות המשיח.

## מה נפרס
הענף `manual-blur-ui` כולל הכל (שרשרת: `manual-blur` ← `manual-blur-render` ← `manual-blur-ui`, מעל מה שכבר נפרס: `header-and-ad-column`). מתוכו נעשה `git archive`.
- **backend** (Go + ה-frontend שנבנה בתוכו): תמונה חדשה `thechannel-backend`.
- **moderation** (Python): תמונה חדשה `thechannel-moderation` (נקודת הקצה `/manual-image`).
- **הדגל `MANUAL_BLUR` נשאר כבוי** (לא קיים ב-`.env`) עד שלב 4. בלי הדגל: הנתיבים 404, אין כפתור, ולא מוגשת גרסה ידנית, כלומר האתר מתנהג בדיוק כמו היום.

## שלב 1: גיבוי (לפני כל שינוי)
```bash
D=$(date +%Y%m%d); B=/root/backup-manual-$D; mkdir -p $B
cp /opt/thechannel/.env $B/env.before && chmod 600 $B/env.before
docker exec thechannel-redis-1 redis-cli -s /data/kvrocks.sock get settings:list > $B/settings-list.before.json && chmod 600 $B/settings-list.before.json
docker image tag thechannel-backend:latest    thechannel-backend:before-manual-$D
docker image tag thechannel-moderation:latest thechannel-moderation:before-manual-$D
```
**פקודת חזרה** (נכתבת לשרת בשלב הזה, `/root/rollback-manual-<תאריך>.sh`, ומורצת בפקודה אחת):
```bash
cp $B/env.before /opt/thechannel/.env
docker tag thechannel-backend:before-manual-$D thechannel-backend:latest
docker tag thechannel-moderation:before-manual-$D thechannel-moderation:latest
cd /opt/thechannel && docker compose -f docker-compose.prod.yml -f docker-compose.bridge-net.yml up -d --no-deps --no-build moderation backend
```
(קבצי `manual/` בכרך `blurred` ושדה `manualBlur` ב-YAML של קבצים נשארים; הקוד הישן מתעלם מהם.)

## שלב 2: העלאה ובנייה (האתר ממשיך לעבוד על התמונות הישנות)
`git archive` של הענף המאוחד ← `scp` ← פריסה ל-`/opt/thechannel` ← בנייה ברקע על השרת (`nohup docker compose -f docker-compose.prod.yml build backend moderation > /root/build-manual.log`), עם בדיקה של סוף הלוג. כמה דקות; צריך ~1GB דיסק (יש 30GB פנוי).

## שלב 3: החלפת הקונטיינרים (הדגל עדיין כבוי)
1. `moderation` ראשון: הפעלה מחדש וטעינת מודלים לוקחת כדקה. בזמן הזה העלאות חדשות נשארות "ממתין" (מטושטש) ומנסות שוב אוטומטית כל 2 דקות.
2. `backend`: כמה שניות. ההפעלה מחדש מחזירה לתור את הקבצים הממתינים.
3. **בדיקת עשן (הדגל כבוי)**, ללא התחברות, כמו אחרי כל פריסה:
   - דף הבית 200.
   - תמונה וסרטון אמיתיים מההודעות הציבוריות, בקשה בלי התחברות ← 401 (כולל `?view=public`, בלי סיומת, ו-Range).
   - `GET /api/admin/files/<id>/manual-blur` ← 404 (הדגל כבוי).
   - קובץ האימות של גוגל ו-`/ad-assets/` עונים 200.
   - כל הקונטיינרים `Up`, `moderation` `healthy`.

   **אם משהו נכשל: עוצרים ומריצים את פקודת החזרה.**

## שלב 4: הדלקת הדגל
```bash
echo 'MANUAL_BLUR=1' >> /opt/thechannel/.env
cd /opt/thechannel && docker compose -f docker-compose.prod.yml -f docker-compose.bridge-net.yml up -d --no-deps --no-build backend
```
(רק `backend` מופעל מחדש. מי שרשאי: הבעלים ב-`ADMIN_USERS`, ומי שמופיע ב-`APPROVER_EMAILS` ובנוסף מנחה.)

## שלב 5: בדיקת עשן עם הדגל דלוק
- דף הבית 200; מדיה בלי התחברות עדיין 401.
- `GET /api/admin/files/<id>/manual-blur` בלי התחברות ← 401 (ולא 404: הנתיב קיים אבל סגור).
- **הרינדור בשרת:** `docker exec thechannel-moderation-1` שולח ל-`/manual-image` בקשה על קובץ מקור קיים עם מזהה בדיקה, מוודא 200 וקובץ פלט, ומוחק אותו מיד. התמונה לא נצפית ולא נשמרת.
- **כלי המנהל (אתה, בדפדפן):** פתח תמונה פתוחה בערוץ ← "טשטוש ידני" ← צייר מלבן ← "שמור" ← "הצג כמו הקוראים": הצורה מטושטשת. ואז "טשטוש ידני" ← "מחק את כל הצורות" ← "שמור" כדי להחזיר למצב המקורי. **לא משאירים טשטוש ידני בתמונות אמיתיות מהבדיקה.**
- אם הכלי לא עובד: מכבים (מסירים את `MANUAL_BLUR=1` מה-`.env` ומפעילים מחדש את `backend`) או מריצים את פקודת החזרה.

## סיכונים ידועים
- הפעלה מחדש של `moderation`: כדקה בלי בדיקות אוטומטיות (העלאות ממתינות ומנוסות שוב).
- רינדור ידני מתחרה על מעבדים עם בדיקה אוטומטית רק לשברירי שנייה (12 מגה-פיקסל כ-0.3 שניות).
- הדגל נבדק מקומית עם השירות האמיתי בלבד. בשרת החי הוא עדיין לא רץ.
- בנייה בשרת דורשת אינטרנט (פונט Google ב-`ng build`). בשרת זה עבד בפריסות הקודמות.
