# פריסת הטשטוש הידני לסרטונים (MVP) לשרת החי: תוכנית

**סטטוס: תוכנית בלבד. לא בוצעה. לא מריצים אותה בלי "פרוס" מפורש.** שרת: `83.229.70.68` (`/opt/thechannel`). לא נוגעים בשרת הישן, בגשר, ב-WAHA ובבוט של ימות המשיח.

## מה נפרס
הענף `manual-blur-video-ui` כולל הכל (שרשרת: `manual-blur-video` ← `manual-blur-video-render` ← `manual-blur-video-ui`, מעל מה שכבר נפרס: `manual-blur-ui`). מתוכו נעשה `git archive`.
- **backend** (Go + ה-frontend שנבנה בתוכו): ממשק עריכת סרטון, משימת הרינדור, ו**תיקון הבאג בתמונות** (מחיקת טשטוש ידני דרך שירות הטשטוש).
- **moderation** (Python): `/manual-video`, `/manual-commit`, `/manual-remove`, סריקה בהפעלה.
- **הדגל `MANUAL_BLUR_VIDEO` נשאר כבוי** (לא קיים ב-`.env`) עד שלב 5. `MANUAL_BLUR=1` (תמונות) נשאר דלוק כמו היום.
- **מחיקת הקובץ היתום** `manual/9a/57/9a576f0ec879c8bd90d0263f65dee99d9a86e6c7.jpg` (טשטוש ידני שהוסר ב-25.10 והקובץ נשאר), עם גיבוי, בשלב 4.

## שלב 1: גיבוי (לפני כל שינוי)
```bash
D=$(date +%Y%m%d); B=/root/backup-manualvideo-$D; mkdir -p $B
cp /opt/thechannel/.env $B/env.before && chmod 600 $B/env.before
docker exec thechannel-redis-1 redis-cli -s /data/kvrocks.sock get settings:list > $B/settings-list.before.json && chmod 600 $B/settings-list.before.json
docker image tag thechannel-backend:latest    thechannel-backend:before-manualvideo-$D
docker image tag thechannel-moderation:latest thechannel-moderation:before-manualvideo-$D
docker cp thechannel-moderation-1:/blurred/manual/9a/57/9a576f0ec879c8bd90d0263f65dee99d9a86e6c7.jpg $B/orphan-9a576f0e.jpg   # לפני המחיקה
```
**פקודת חזרה** (נכתבת לשרת בשלב הזה, `/root/rollback-manualvideo-<תאריך>.sh`):
```bash
cp $B/env.before /opt/thechannel/.env
docker tag thechannel-backend:before-manualvideo-$D thechannel-backend:latest
docker tag thechannel-moderation:before-manualvideo-$D thechannel-moderation:latest
cd /opt/thechannel && docker compose -f docker-compose.prod.yml -f docker-compose.bridge-net.yml up -d --no-deps --no-build moderation backend
# (אם רוצים גם את הקובץ היתום בחזרה: docker cp $B/orphan-9a576f0e.jpg thechannel-moderation-1:/blurred/manual/9a/57/ ; לא נחוץ: הוא לא מוגש לאיש)
```

## שלב 2: העלאה ובנייה (האתר ממשיך לעבוד על התמונות הישנות)
`git archive manual-blur-video-ui` ← `scp` ← פריסה ל-`/opt/thechannel` ← בנייה ברקע על השרת (`nohup docker compose -f docker-compose.prod.yml build backend moderation > /root/build-manualvideo.log`), ובדיקת סוף הלוג.

## שלב 3: החלפת הקונטיינרים (דגל הסרטונים כבוי)
1. `moderation` ראשון (כדקה בלי בדיקות אוטומטיות; העלאות חדשות ממתינות ומנוסות שוב אוטומטית), עד `healthy`.
2. `backend` (כמה שניות).
3. **בדיקת עשן (דגל סרטונים כבוי):** דף הבית 200; תמונה וסרטון אמיתיים מההודעות הציבוריות בלי התחברות ← 401 (כולל `?view=public`, `?view=base`, בלי סיומת, Range); `manual-blur` בלי התחברות ← 401 (נתיב תמונות דלוק); כל הקונטיינרים `Up`, `moderation` `healthy`; קובץ האימות של גוגל, `/ad-assets/` והלוגו 200. **כל כישלון: עוצרים וחוזרים.**

## שלב 4: מחיקת הקובץ היתום (עם הקוד החדש, דרך השירות)
```bash
docker exec thechannel-moderation-1 python -c "import json,urllib.request as u; r=u.Request('http://127.0.0.1:8000/manual-remove', data=json.dumps({'path':'manual/9a/57/9a576f0ec879c8bd90d0263f65dee99d9a86e6c7.jpg'}).encode(), headers={'Content-Type':'application/json'}); print(u.urlopen(r).read())"
docker exec thechannel-moderation-1 ls /blurred/manual/9a/57 2>&1     # הקובץ נעלם
```
(הקובץ `e963e94c…` הוא טשטוש ידני **פעיל** על תמונה אמיתית. לא נוגעים בו: אתה מחליט אם להסיר אותו בממשק.)

## שלב 5: הדלקת דגל הסרטונים
```bash
echo 'MANUAL_BLUR_VIDEO=1' >> /opt/thechannel/.env
cd /opt/thechannel && docker compose -f docker-compose.prod.yml -f docker-compose.bridge-net.yml up -d --no-deps --no-build backend
```
(רק `backend` מופעל מחדש. מי שרשאי: הבעלים ב-`ADMIN_USERS`, ומי שמופיע ב-`APPROVER_EMAILS` ובנוסף מנחה.)

## שלב 6: בדיקת עשן עם הדגל דלוק
- דף הבית 200; מדיה בלי התחברות 401; `manual-blur` של סרטון בלי התחברות ← 401.
- **רינדור בשרת:** `docker exec thechannel-moderation-1` שולח ל-`/manual-video` בקשה על קובץ סרטון קיים (נקרא בלבד) עם מזהה משימה ושם פלט בדיקה (`manual/aa/aa/<40 תווי a>.<16 תווים>.mp4`) ושני טשטושים; מוודא 200, `samples_checked` גדול מ-0 ואורך תקין; ואז `/manual-remove` על הפלט. הסרטון לא נצפה ולא נשמר, ונשארים 0 קבצים ב-`/blurred/manual`.
- בדיקת עומס: הרינדור רץ עם `nice` ולא אמור לשנות את התור האוטומטי (בודקים `uptime` לפני ובמהלך).

## בדיקה אחת שאתה עושה בדפדפן
1. היכנס כבעלים ופתח **סרטון קצר פתוח** בערוץ (לא תמונה). לחץ **"טשטוש ידני"**. הסרטון נטען ונגן.
2. בשנייה הראשונה צייר **מלבן** על אזור בסרטון. לחץ על פס הזמן לשנייה אחרת, לחץ "בחירה והזזה" וגרור את המלבן למקום אחר: זו נקודת מפתח. לחץ **"שמור ורנדר"**.
3. המתן לסרגל ההתקדמות עד שהחלון נסגר. לחץ **"הצג כמו הקוראים"** וגם נגן: המלבן מטושטש ומתחלף חלק בין שני המקומות, והקול נשמע.
4. **אחר כך נקה:** פתח שוב "טשטוש ידני", "מחק הכל" ו"שמור (הסר...)". **אל תשאיר טשטוש ידני בסרטונים אמיתיים מהבדיקה.**
אם משהו לא עובד: מסירים `MANUAL_BLUR_VIDEO=1` מ-`.env` ומפעילים מחדש את `backend`, או מריצים את פקודת החזרה.

## סיכונים ידועים
- הפעלה מחדש של `moderation`: כדקה בלי בדיקות אוטומטיות (העלאות ממתינות ומנוסות שוב).
- סרטון ארוך מתרנדר ב-0.05 עד 0.25 שניות לכל שנייה (נמדד בשרת: 90 שניות ב-11 שניות). רינדור רץ עם עדיפות נמוכה, אחד בכל פעם.
- בנייה בשרת דורשת אינטרנט (פונט Google ב-`ng build`).
- לא נבדק מול נטפרי: נגן וקפיצות נבדקו אצלך ועברו; ממוזערות עדיין לא קיימות (שלב נפרד).
- ה-MVP בלי ממוזערות בפס הזמן, בלי זום, ובלי ביטול רינדור בלי למחוק (סגירת החלון משאירה את הרינדור רץ).
