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

## HOLD_VIDEOS_UNTIL_APPROVED (backend, off by default)

`HOLD_VIDEOS_UNTIL_APPROVED=1` makes every video that is **uploaded while the flag is on** wait for a human before readers get it.
The flag is read at upload time (`holdRequired` in the file's metadata): videos that already exist have no such mark and stay
visible. With the flag off the mark is ignored (everything is served as usual); turning the flag on again holds the unapproved ones again.
Images are not affected at all. The automatic check and the blur run as usual.

- **Readers:** a held video is a 404 and the page says "ממתין לאישור". "פתח לכולם" does not publish it either.
- **Moderators and approvers** see the video as always. While the flag is on, only the approvers (`ADMIN_USERS` + `APPROVER_EMAILS`;
  an approver must also be a moderator in the users list) can open the review grid, save corrections and approve. Without the flag
  every moderator keeps the grid, as before.
- **"אשר פרסום"** (in the grid) works only after the approver requested the video the way readers get it (`?view=public`, the button
  "הצג כמו הקוראים") **in the current check**. The server remembers which version they looked at (variant, file revision,
  check number). A saved correction, "check again" or a manual decision changes it, ends the approval and starts over.
  The approval stores who approved and when (`approvedBy`, `approvedAt`, and a line `approved` in `logs/moderation.yaml`).
- **Notification:** when the first automatic check of a held video finishes, the backend posts a text (no media) with a link
  `PUBLIC_URL/review/<fileId>` to `BRIDGE_NOTIFY_URL` with `X-Notify-Key: BRIDGE_NOTIFY_KEY`. The bridge forwards it to the private
  Chat space. Bridge side: `NOTIFY_KEY` (same value) turns `POST /notify` on; it answers only connections from loopback/private
  addresses, refuses anything that came through a proxy header, and compares the key in constant time (`bridge/notify-guard.js`).
  The bridge container publishes no port, so the backend joins the bridge's Docker network: set `BRIDGE_NETWORK=bridge_default` in the
  backend's `.env` (`deploy/install.sh` then adds `docker-compose.bridge-net.yml`); the extra module `notify-guard.js` must be mounted
  next to `bridge.js` in the bridge's compose.
- **Before opening to the public:** turn the flag on (it only affects videos uploaded afterwards).
- Tests: `tests/e2e_hold_videos.py` (API), `bridge/run-tests.sh` (notify guard and endpoint).

## NOINDEX_SITE (backend, off by default)

`NOINDEX_SITE=1` asks search engines to stay away from the whole site, independently of `PRIVATE_SITE`: every response carries
`X-Robots-Tag: noindex, nofollow` (pages, API and files), the app's HTML has `<meta name="robots" content="noindex, nofollow">`,
`/robots.txt` says `Disallow: /`, and `/sitemap.xml` is a 404. Link previews (Open Graph) still work. It is a request, not access
control: only login restricts who can read.

## "Infer Request is busy" (fixed)
The gender and body models run through OpenVINO. A compiled model used to run every call on one shared infer request, which is not
thread-safe. The service checks an image and a video at the same time (separate locks, one thread per HTTP request), so when both
reached a model together the second one got `RuntimeError: Infer Request is busy`. The server treats any analysis exception as final
(`blurred` / `analysis_error`), so a file was blurred and marked "error in check" although nothing was wrong with it. Now every thread
keeps its own infer request (`_OvModel` in `analyzer.py`). Regression test: `moderation/tests/test_infer_threads.py` (it fails with 400+
"busy" errors on the old code).
## A stuck video no longer blocks the queue (backend)
Before: when the service could not check a file (it crashed or ran out of memory on it, or hung), the file stayed in the pending set and the
2-minute sweep put it back in the queue again and again. Each try could hold the single video worker for up to 45 minutes, duplicates piled
up in the queue, and every restart of the backend started over, so one bad video delayed all the others.
Now (`backend/moderation_retry.go`, counting logic and tests in `backend/modretry/`):
- A failed check is counted per file (Redis hash `moderation:attempts`, survives restarts). The file pauses for `MODERATION_RETRY_DELAY` x number
  of failures (default 3 min, 6 min) while other files go first.
- After `MODERATION_MAX_ATTEMPTS` failures (default 3, 0 = never give up) the file is given up: it stays **fully blurred** for readers,
  gets `analysis_error` ("שגיאה בבדיקה"), is marked "needs review" for the moderators and leaves the queue. A moderator can open it by hand or press
  "check again" (counting starts from zero).
- One check is stopped after `MODERATION_ATTEMPT_TIMEOUT` (default 45 min, the old HTTP limit: a legitimate 15-minute video takes ~40 min at 3 cores before the speed-up) and the service is told to `/cancel` the abandoned work.
- The sweep (`MODERATION_SWEEP_INTERVAL`, default 2 min) queues a file only if it is not paused, not already waiting and not being checked.
Tests: `go test ./modretry/` (in `backend/`, no Redis needed) and `tests/e2e_stuck_video.py` (needs `tests/docker-compose.stuck-test.yml`, a fake
moderation service that crashes / hangs / answers; it fails on the old code).
## Analysis speed (measured 22.10.2026, 60 s clip, 3 CPUs, strict level)
Where the time goes: ~93% of the analysis is the YOLOX-s person detector (900 calls per minute of 25 fps video: 300 samples + 600
between-sample frames, `dense_person_step=2` in strict). Faces, gender and body are ~5% together. Scaling with cores is almost linear up to
`THREADS` (new server: 1 core 495 s, 2 cores 230 s, 3 cores 155 s, 4 cores 154 s because `THREADS=3`).

Switches (all off by default, so nothing changes until they are set in `.env` / compose):
| variable | effect | measured |
|---|---|---|
| `PERSON_BACKEND=ov` | same YOLOX-s weights through OpenVINO; the network input is shaped like the video (848x480 -> 640x384, not 640x640), so the grey padding is not computed | -43% time, 0 real leaks (leak check, both test videos) |
| `DENSE_INPUT_SIDE=416/480` | between-sample frames at a smaller scale | -20% more, but **23 real leaks** on the crowd video: do not use |
| `DENSE_PERSON_STEP=0/3` | fewer / no between-sample detections | misses boxes: do not use without a review |
| `DETECT_FPS=3/4` | fewer samples | -18%, misses boxes: do not use without a review |
Tools: `moderation/tests/bench_video.py` (time per model + comparison of the blur boxes with a baseline run), `leak_check.py`
(`CHECK_PERSON_BACKEND=ort` checks the output with the other backend), `test_person_ov.py`.

## MANUAL_BLUR (backend, off by default): manual blur on images
`MANUAL_BLUR=1` lets owners (`ADMIN_USERS`) and approvers (`APPROVER_EMAILS`, who must also be moderators) draw rectangles / ellipses on an
**image**. The result is a separate file, `<blurred>/manual/xx/yy/<fileid>.jpg`; the original and the automatic versions are never touched.
- **It only adds blur.** It is drawn on what readers get from the automatic check: the original of an "open" file, the regional picture of a
  "regional" one. A fully blurred (or still unreviewed under `STRICT_UNTIL_REVIEWED`) picture, a GIF and a video are not editable.
- **It is valid for exactly that base** (`manualblur.Signature`: status, check generation, time of the automatic check, the base file's version).
  After "check again", saved figure corrections, a manual decision or a new regional picture, readers get the automatic version again;
  the saved shapes stay, marked `stale` for the moderator. A manual version is never served on a base it was not made on.
- **With the flag off** nothing is reachable (404) and no manual version is served.
- API (owners / approvers only): `GET|POST|DELETE /api/admin/files/{id}/manual-blur`; POST `{"shapes":[{"type":"rect"|"ellipse","x","y","w","h"}]}`
  (shares of the picture, at most 50; no shapes = clear). `?view=base` (same people) serves the picture before the manual blur, for the editor.
  The file info (`/api/files/{id}/moderation`) has a `manualBlur` block for them. Log: `manual-blur` / `manual-blur-cleared` in `logs/moderation.yaml`.
- Tests: `go test ./manualblur/`; `go test -run Manual .` in `backend/` (needs any Redis/kvrocks: `docker run --rm -d -p 127.0.0.1:16666:6666
  apache/kvrocks:2.17.0`, then `REDIS_PROTOCOL=tcp REDIS_ADDR=127.0.0.1:16666`); `tests/e2e_manual_blur.py` (`EXPECT_FLAG=on|off`, see the file).
