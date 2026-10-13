# מערכת טשטוש אוטומטית

כל תמונה או סרטון שעולים, גם מהממשק (`/api/admin/upload`) וגם מהייבוא (`/api/import/upload`), נבדקים אוטומטית.

## הכלל: טשטוש אזורי
- מטושטשת רק כל דמות שאינה גבר בוודאות, על כל הגוף ולא רק הפנים. שאר התמונה או הסרטון נשארים רגילים.
- **החלטה לפי הפריימים הברורים:** כל דמות (track) נשפטת לפי `BEST_SIGHTINGS` (3) הראיות הכי ברורות שלה: הפנים הגדולות ביותר, והגוף הגבוה ביותר כשמודל הגוף מותקן. לא לפי ממוצע של כל הפריימים.
- **קהל:** כל דמות מטושטשת בנפרד. קבוצה צפופה של דמויות חופפות מקבלת מלבן אחד, וכל הפריים מטושטש רק כשהאזורים המטושטשים מכסים את רובו ממילא.
- **החלטה אוטומטית:** `open` כשאין מה לטשטש, `regional` כשטושטשו אזורים, `blurred` (טשטוש מלא) בשגיאה, בתמונה שכמעט כולה מטושטשת, או באנימציה (GIF). ההחלטה מתפרסמת לקוראים מיד, בלי אישור.

### רמת החמרה (הגדרות ערוץ ← "רמת החמרה בטשטוש אוטומטי", המפתח `moderation_level`)
| | מחמיר (ברירת מחדל) | רגיל | מקל |
|---|---|---|---|
| גבר לפי הפנים הברורות | ≥ 0.90 | ≥ 0.80 | ≥ 0.70 |
| פנים ברורות אחת של "אישה" | פוסלת | לא, רק הממוצע | לא, רק הממוצע |
| גבר לפי הגוף בלבד (כשמותקן) | ≥ 0.92, רק בלי פנים | ≥ 0.85 | ≥ 0.75 |
| זיהוי חלש של דמות | מטושטש | מטושטש | מתעלמים |
| דמויות רחוקות בלי פנים ובלי גוף ברור | מטושטשות | מטושטשות | גלויות (קטנות מ-12% מגובה הפריים) |
| פיצול מסלולים בחפיפה | כן | כן | לא |

הרמה חלה על קבצים חדשים. לקובץ קיים יש כפתור "בדוק מחדש", שמריץ את הבדיקה מחדש ומבטל החלטה ידנית.

### זיהוי לפי הגוף
המודל `person-attributes-recognition-crossroad-0230` של Intel (Apache-2.0) נותן הסתברות לגבר לפי הגוף. הוא שימושי לדמויות מהגב, מרחוק, או עם פנים קטנות. הוא מותקן יחד עם שאר המודלים (ראו "הרכב השירות").

### סרטונים
1. **מעבר ניתוח:** זיהוי `DETECT_FPS` פעמים בשנייה. כל זיהוי משויך למסלול (tracking), וההחלטה נעשית לכל המסלול.
2. **מעבר רינדור:** **כל פריים** מעובד. מלבן הטשטוש מוגדל בשוליים ומחושב באינטרפולציה בין זיהויים. לפני הזיהוי הראשון יש כניסה מוקדמת, ואחרי האחרון נשמר הטשטוש עוד `HOLD_SEC`.
3. **רשת ביטחון:** אם פריים כלשהו של דמות מטושטשת נשאר בלי כיסוי, כל הפריים מטושטש (מדווח כ-`uncovered_frames`).
4. **סאונד:** נשמר (AAC).
5. **חיתוך לאזורים:** `FACE_TILING=1` מפעיל מעבר שני ומוגדל של זיהוי פנים קטנות. זה מוסיף כ-125% לזמן הניתוח, ובסרטון WhatsApp ברזולוציה נמוכה כמעט לא שיפר.

עד שהעיבוד מסתיים הסטטוס הוא `pending`, וקוראים רואים גרסה מטושטשת לגמרי עם התווית "בבדיקה".
תמונות ממתינות בתור נפרד מסרטונים, כך שתמונה לא מחכה לסרטון ארוך.

## אכיפה בשרת
`GET /api/files/{id}` מחזיר לקורא גרסה לפי הסטטוס:

| סטטוס | מה הקורא מקבל |
|---|---|
| `open` | המקור |
| `regional` | הגרסה עם הטשטוש האזורי (וידאו או JPEG) |
| `blurred` / `pending` | JPEG מטושטש לגמרי. בסרטון זה poster בלי הווידאו עצמו |

מנהל (Moderator ומעלה) רואה תמיד את המקור. אם הוא מוסיף `?view=public` הוא רואה את מה שהקוראים רואים.

התשובות נשלחות כך:
- `Content-Disposition: inline` ו-Content-Type אמיתי.
- תמיכה ב-Range (נדרשת לניגון וידאו).
- `Cache-Control: private, no-cache`, `Vary: Cookie` ו-ETag נפרד לכל גרסה, כך ש-proxy לא יגיש מקור לקורא.

מנהל יכול להוסיף `?view=public` כדי לראות בדיוק מה הקוראים רואים.

## API
| נתיב | הרשאה | תיאור |
|---|---|---|
| `GET /api/files/{id}/moderation` | כולם | סטטוס ו-`publicVariant` (מה הקוראים מקבלים). מנהלים מקבלים גם את הסיבות, מספר הדמויות שטושטשו ומי החליט. |
| `POST /api/admin/files/moderation` `{"id","status":"open"\|"regional"\|"blurred"}` | Moderator | החלטה ידנית. אחרי החלטה ידנית, הבדיקה האוטומטית לא דורסת אותה. |
| `POST /api/admin/files/reprocess` `{"id"}` | Moderator | בדיקה מחדש לפי הרמה הנוכחית. מבטלת החלטה ידנית. |
| `POST /api/import/upload` (multipart `file`, כותרת `X-API-Key`) | מפתח API | העלאה מהגשר (וואטסאפ). מחזיר `{url, filename, filetype}`, ואת `url` משבצים בטקסט ההודעה, למשל `[image-embedded#](url)` או `[video-embedded#](url)`. |

כל החלטה, אוטומטית או ידנית, נרשמת ב-`logs/moderation.yaml`.
ב-metadata של הקובץ (`channel_data/xx/yy/<id>.yaml`) נשמרים השדות `moderation`, `blurredPath`, `reviewedBy`, `reviewedAt`, `autoDecision`, `autoReasons` ו-`autoConfidence`.

> שינוי אבטחה: `/api/import/post` ו-`/api/import/upload` נדחים כשלא הוגדר `api_secret_key` בהגדרות. קודם לכן מפתח ריק התקבל.

## הרכב השירות
קונטיינר Python (onnxruntime ו-OpenVINO על CPU). לכל רכיב השירות בוחר את המודל לפי הקבצים שמותקנים ב-`moderation_models/`. מודל ברישיון מסחרי מקבל עדיפות. המודלים הפעילים מוצגים ב-`GET /health`.

| רכיב | מודל ברישיון מסחרי (ברירת מחדל) | מודל מקורי (מחקר) | אם אין אף אחד |
|---|---|---|---|
| זיהוי אנשים | YOLOX-s, `person_yolox.onnx` (Apache-2.0) | YOLOv8s, `person.onnx` (AGPL-3.0) | השירות לא עולה |
| זיהוי פנים | YuNet, `face_yunet.onnx` (MIT) | SCRFD, `face_det.onnx` (InsightFace, לא-מסחרי) | השירות לא עולה |
| מגדר לפי פנים | Intel age-gender-recognition-retail-0013, `gender_omz.*` (Apache-2.0) | InsightFace genderage (לא-מסחרי) | כל פנים נחשבות "לא ודאי", ולכן מטושטשות |
| מגדר לפי גוף | Intel person-attributes-recognition-crossroad-0230, `par.*` (Apache-2.0) | אין | ההחלטה לפי הפנים בלבד |

**התקנת המודלים המסחריים** (עם אימות checksum רשמי). `deploy/install.sh` מריץ את זה אוטומטית:
```
python moderation/fetch_models.py
python moderation/fetch_models.py --local par model.xml model.bin   # קבצים שהורדו ידנית
```
- נטפרי חוסם את קבצי ה-`.bin` של Intel להורדה במחשב המקומי. בשרת אין חסימה כזו.
- `MODEL_PROFILE=research` מכריח את המודלים המקוריים, למשל להשוואה.
- המודלים המקוריים נבנים פעם אחת עם `moderation/Dockerfile.models`.

### השוואה שבוצעה (מחמיר, אותו מודל מגדר בשני המקרים)
| | YOLOv8 + SCRFD | YOLOX + YuNet |
|---|---|---|
| זמן ניתוח לשנייה של וידאו | 1.21–1.33 שנ' | **0.70–0.73 שנ'** |
| דמויות שזוהו לכל פריים (הפגנה) | 7.7 | **9.6** (פחות פספוסים) |
| גברים שזוהו בוודאות (הפגנה) | 155 | **211** |
| תמונות לדוגמה | תקין | תקין |

ההשוואה הורצה עם `moderation/tests/compare_models.py`.

**בדיקת דליפה מלאה** (על כל פריים, `moderation/tests/run_leak_check.sh`, רמה מחמירה, YOLOX+YuNet):
- **ריצה ראשונה:** 4 דליפות אמיתיות בסרטון ההפגנה. אלה היו דמויות זעירות (כ-20 פיקסלים) שהופיעו 4 פריימים בדיוק בין פריימים שנדגמו.
- **התיקון:** ברמה המחמירה מורץ זיהוי אנשים גם על כל פריים שני (`dense_person_step=2`), בסף נמוך יותר (`DENSE_PERSON_MIN=0.10`). דמות שמופיעה שם ולא שייכת לדמות מוכרת מטושטשת.
- **אחרי התיקון:** 0 דליפות בשלושת הסרטונים.
- **המחיר:** העיבוד ברמה המחמירה עולה לכ-2 שניות לכל שנייה של וידאו (על 2 מעבדים).

בודק הדליפה משווה כל "דמות" שנמצאה בפלט לפריים המקורי. כך הוא מבדיל דליפה אמיתית מגוש מפוקסל ליד אזור מטושטש, שהגלאי טועה לזהות כדמות.

**מגבלה:** מודל המגדר של Intel מתוכנן לפנים של 62 פיקסלים ומעלה. בסרטוני WhatsApp הפנים קטנות יותר (חציון כ-29), ולכן יותר דמויות יישארו "לא ודאי", כלומר מטושטשות. הדבר נבדק רק בשרת, כי כאן המודל חסום.

השירות רץ כמשתמש לא-root. הוא קורא את המקורות במצב קריאה בלבד וכותב רק ל-volume `blurred`. הוא אינו חשוף החוצה, וה-backend פונה אליו ב-`MODERATION_URL`.
אם השירות לא זמין, הקבצים נשארים `pending` (מטושטשים), ונבדקים מחדש אוטומטית כל 2 דקות.

## רישוי
עם המודלים המסחריים (ברירת המחדל בהתקנה), כל המודלים מתירים שימוש מסחרי:
- **YOLOX:** Apache-2.0.
- **YuNet:** MIT.
- **מודלי Intel OMZ:** Apache-2.0.

**מה צריך לעשות:**
- **לשמור את הודעות הרישוי:** Apache-2.0 ו-MIT דורשות לצרף את טקסט הרישיון והודעת זכויות היוצרים בהפצה. אם רק מפעילים שירות ולא מפיצים את המודלים, החובה מינימלית.
- **המודלים המקוריים:** YOLOv8 תחת AGPL, ו-InsightFace לשימוש לא-מסחרי בלבד. הם נשארים רק כאופציה (`MODEL_PROFILE=research`), ולא נשלחים לשרת כברירת מחדל.
- **הקוד של TheChannel:** הוא תחת GPLv3. מותר להשתמש בו מסחרית. שינויים שמופצים חייבים להיות בקוד פתוח, אבל הפעלה כשירות אינה נחשבת הפצה.

## DECISION_V2 (off by default) and the moderator queue

`DECISION_V2=1` changes only what stays blurred, never what is released: automatic release is exactly the current rules
(verified on 3,211 figures: 0 differences). Figures with clear male faces (at least `CLEAR_MIN_SIGHTINGS`=2 sightings of
`CLEAR_FACE_PX`=60 px or more, mean of the best 3 and the median >= the level's male threshold, no face <= 0.5, at most
`VOTE_FEMALE_MAX_SHARE`=10% female-looking sightings) are labelled `likely_man`: they stay blurred, are shown first in the
moderator's review grid (yellow queue) and counted in the file badge. Why not release them: the face model reads some women as
male with confidence 1.00 (labelled examples in the demo), and no face/body rule separated them from men. A woman "by body" with
no face needs a body score <= `BODY_WOMAN_NOFACE`=0.15; in between is `uncertain_gender`.

Always on (metadata only): `needs_review` + `review_reasons=["crowd"]` for videos with at least `CROWD_MIN_FIGURES`=10 figures
of which at least `CROWD_NOFACE_SHARE`=50% have no usable face (faces under `MIN_FACE_PX`).
The review grid has "approve all men in the file" (every blurred figure in the grid) and "approve all likely men";
both only fill the pending choices, saving is a separate click. Unit tests: `moderation/tests/test_decision_v2.py`.

## STRICT_UNTIL_REVIEWED (backend, off by default)

`STRICT_UNTIL_REVIEWED=1` in the backend's `.env` is a temporary strict mode. Until a moderator has opened the review grid and saved
(also a save with no corrections; or has decided the file by hand), readers get: a file in which the automatic check found
people: only the fully blurred version; a video flagged "needs review" (crowd): nothing at all (404, the page shows a placeholder).
Moderators see everything as usual (`?view=public` shows them what readers get). It only ever hides more: automatic release is
unchanged. "Check again" resets the review. Files processed before this build have no crowd flag until they are re-checked (they
are still fully blurred while unreviewed). Verified with two backends on the same data (old vs new, flag off): 84 responses, 0 differences.
