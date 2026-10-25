import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, Subject } from 'rxjs';
import { ResponseResult } from '../models/response-result.model';
import { NbDialogService } from '@nebular/theme';
import { FigureReviewComponent } from '../components/admin/figure-review/figure-review.component';
import { ManualBlurComponent } from '../components/admin/manual-blur/manual-blur.component';
import { boxRatio, dimsFromUrl } from '../media-dims';

export type ModerationStatus = 'pending' | 'open' | 'regional' | 'blurred';
export type ModerationChoice = 'open' | 'regional' | 'blurred';

export interface FileModeration {
  id: string;
  status: ModerationStatus;
  kind: string;
  /** What readers receive: the original, the regionally blurred version, the fully blurred one, or (MANUAL_BLUR) the version with a manual blur on top. */
  publicVariant?: 'original' | 'regional' | 'blurred' | 'hidden' | 'manual';
  autoRegions?: number;
  autoLevel?: string;
  autoFullFrames?: number;
  reviewedBy?: string;
  reviewedAt?: string;
  autoDecision?: string;
  autoReasons?: string[];
  autoConfidence?: number;
  /** Moderators only: the file cannot be judged automatically (e.g. a crowd) and waits for a human. */
  needsReview?: boolean;
  reviewReasons?: string[];
  /** Moderators only: blurred figures with clear male faces that wait for confirmation. */
  likelyMen?: number;
  /** Moderators only (STRICT_UNTIL_REVIEWED): nobody has reviewed the figures yet, readers get the fully blurred version. */
  unreviewed?: boolean;
  /** Changes whenever the picture/video readers get is regenerated: part of the media URL so that browsers fetch the new one. */
  rev?: string;
  /** Moderators only, HOLD_VIDEOS_UNTIL_APPROVED: a video that readers do not get until an approver approves it. */
  hold?: HoldInfo;
  /** Moderators only: what readers will get once the held video is approved. */
  previewVariant?: 'original' | 'regional' | 'blurred';
  /** Moderators only: may this person open the review grid (every moderator, or only approvers while the hold flag is on). */
  canReview?: boolean;
  /** Owners / approvers with MANUAL_BLUR on, images only: the manual blur tool for this picture. */
  manualBlur?: ManualBlurInfo;
}

export interface ManualBlurInfo {
  available: boolean;
  reason?: string;
  /** Readers get the manual version. */
  active: boolean;
  /** A manual blur was saved, but the automatic result changed since, so readers do not get it. */
  stale?: boolean;
  shapes: number;
}

export interface HoldInfo {
  held: boolean;
  approvedBy?: string;
  approvedAt?: string;
  /** This approver has opened the video as readers see it, in the current check. */
  viewed?: boolean;
  pending?: boolean;
  canApprove?: boolean;
}

const REASONS: Record<string, string> = {
  no_people: 'אין אנשים',
  men_only: 'גברים בלבד',
  woman: 'זוהתה אישה',
  uncertain_gender: 'מגדר לא ודאי',
  person_without_clear_face: 'דמות בלי פנים ברורות',
  face_too_small: 'פנים קטנות מדי לזיהוי',
  analysis_error: 'שגיאה בבדיקה',
  no_frames: 'לא נמצאו פריימים',
  crowd: 'קהל צפוף',
  low_confidence_person: 'זיהוי בביטחון נמוך',
  overlap_split: 'דמויות חופפות',
  video_too_long: 'סרטון ארוך מדי',
  dense_crowd: 'קבוצה צפופה',
  inseparable: 'דמויות שאי אפשר להפריד',
  woman_body: 'זוהתה אישה לפי הגוף',
  likely_man: 'כנראה גבר (ממתין לאישור)',
};

const BADGES: Record<ModerationStatus, string> = {
  open: 'פתוח לכולם',
  regional: 'טשטוש אזורי לקוראים',
  blurred: 'טשטוש מלא לקוראים',
  pending: 'בבדיקה · מטושטש לקוראים',
};

const CHOICES: { status: ModerationChoice; label: string }[] = [
  { status: 'open', label: 'פתח לכולם' },
  { status: 'regional', label: 'טשטוש אזורי' },
  { status: 'blurred', label: 'טשטוש מלא' },
];

const FILE_URL = /\/api\/files\/([0-9a-f]{40})/;

/**
 * Decorates media inside rendered messages according to the server-side moderation status.
 * The server already sends readers only the blurred version; this adds the UI around it:
 * readers get a non-playable poster for blurred videos, moderators get a status badge and actions.
 */
@Injectable({
  providedIn: 'root'
})
export class MediaModerationService {
  private cache = new Map<string, Promise<FileModeration>>();
  private updates = new Subject<{ id: string; status: ModerationStatus }>();
  updates$ = this.updates.asObservable();

  constructor(private http: HttpClient, private dialog: NbDialogService) { }

  /** Called from the SSE stream ('file-moderation' events). */
  notify(id: string, status: ModerationStatus) {
    this.cache.delete(id);
    this.updates.next({ id, status });
  }

  getStatus(id: string, reload = false): Promise<FileModeration> {
    if (reload || !this.cache.has(id)) {
      const p = firstValueFrom(this.http.get<FileModeration>(`/api/files/${id}/moderation`));
      p.catch(() => this.cache.delete(id));
      this.cache.set(id, p);
    }
    return this.cache.get(id)!;
  }

  async reprocess(id: string) {
    const res = await firstValueFrom(this.http.post<ResponseResult>('/api/admin/files/reprocess', { id }));
    this.notify(id, 'pending');
    return res;
  }

  async setStatus(id: string, status: ModerationChoice) {
    const res = await firstValueFrom(this.http.post<ResponseResult>('/api/admin/files/moderation', { id, status }));
    this.notify(id, status);
    return res;
  }

  /** Wrap every moderated <img>/<video> in the container. Safe to call repeatedly. */
  async decorate(container: HTMLElement | undefined, isModerator: boolean, onlyId?: string) {
    if (!container) return;
    // First every picture / video gets its box with the right proportions (all of them at once, synchronously), so nothing jumps while
    // the statuses are fetched one by one below.
    const wraps: HTMLElement[] = [];
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('img, video, .mod-wrap'))) {
      let wrap = el.classList.contains('mod-wrap') ? el : null;
      if (!wrap) {
        if (el.closest('.mod-wrap')) continue;
        const src = el.tagName === 'VIDEO' ? (el.querySelector('source')?.getAttribute('src') ?? el.getAttribute('src')) : el.getAttribute('src');
        const match = src?.match(FILE_URL);
        if (!src || !match) continue;
        const isVideo = el.tagName === 'VIDEO';
        const box = boxRatio(dimsFromUrl(src), isVideo ? 'video' : 'image');
        const inGallery = !!el.closest('.msg-gallery');
        wrap = document.createElement('div');
        wrap.className = 'mod-wrap';
        wrap.dataset['fileId'] = match[1];
        wrap.dataset['src'] = src.split('?')[0];
        wrap.dataset['tag'] = el.tagName.toLowerCase();
        wrap.dataset['ar'] = box.css;
        wrap.dataset['arKnown'] = box.known ? '1' : '0';
        if (inGallery) wrap.dataset['gallery'] = '1'; // gallery cells are squares (CSS), not the picture's own proportions
        const placeholder = document.createElement('div');
        placeholder.className = 'mod-frame mod-frame-wait';
        if (!inGallery) {
          placeholder.style.aspectRatio = box.css;
          placeholder.classList.add('mod-frame-ar');
          if (isVideo) placeholder.classList.add('mod-frame-video');
        }
        wrap.appendChild(placeholder);
        el.replaceWith(wrap);
      }
      wraps.push(wrap);
    }
    for (const wrap of wraps) {
      const id = wrap.dataset['fileId']!;
      if (onlyId && id !== onlyId) continue;
      try {
        const info = await this.getStatus(id, !!onlyId);
        this.render(wrap, info, isModerator);
      } catch {
        this.render(wrap, { id, status: 'pending', kind: wrap.dataset['tag'] === 'video' ? 'video' : 'image' }, isModerator);
      }
    }
  }

  private render(wrap: HTMLElement, info: FileModeration, isModerator: boolean) {
    const src = wrap.dataset['src']!;
    const isVideo = wrap.dataset['tag'] === 'video' || info.kind === 'video';
    // Cache-buster so the browser refetches after a status change (server also sends ETag + no-cache).
    const variant = info.publicVariant ?? (info.status === 'open' ? 'original' : 'blurred');
    // A moderator can switch to "what readers see" (?view=public); the rev makes the address change after every regeneration.
    const asReader = wrap.dataset['asReader'] === '1';
    const url = `${src}?m=${info.status}-${variant}${info.rev ? '&r=' + info.rev : ''}${asReader ? '&view=public' : ''}`;
    // Readers can play a video only when the server sends them a video (original or regionally blurred).
    // A held video: moderators preview what readers will get after the approval.
    const readerGetsVideo = (info.previewVariant ?? variant) !== 'blurred';
    wrap.replaceChildren();

    // STRICT_UNTIL_REVIEWED: the server refuses to send readers this file at all (crowd video waiting for a moderator).
    if (!isModerator && info.publicVariant === 'hidden') {
      const hidden = document.createElement('div');
      hidden.className = 'mod-hidden';
      hidden.textContent = 'ממתין לאישור';
      wrap.appendChild(hidden);
      return;
    }

    const frame = document.createElement('div');
    frame.className = 'mod-frame';
    if (wrap.dataset['ar'] && !wrap.dataset['gallery']) {
      frame.style.aspectRatio = wrap.dataset['ar'];
      frame.classList.add('mod-frame-ar');
      if (isVideo) frame.classList.add('mod-frame-video');
    }
    // Without a size from the server (older messages) the default box is corrected once the file has loaded.
    const fit = (w: number, h: number) => {
      if (wrap.dataset['arKnown'] === '1' || !w || !h) return;
      wrap.dataset['ar'] = `${w} / ${h}`;
      wrap.dataset['arKnown'] = '1';
      if (!wrap.dataset['gallery']) frame.style.aspectRatio = wrap.dataset['ar'];
    };
    wrap.appendChild(frame);

    if (isVideo && (asReader ? readerGetsVideo : (isModerator || readerGetsVideo))) {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = url;
      video.className = 'mod-media';
      video.addEventListener('loadedmetadata', () => fit(video.videoWidth, video.videoHeight));
      video.setAttribute('aria-label', 'וידאו');
      frame.appendChild(video);
    } else {
      // Readers of a fully blurred / pending video get the blurred poster (an image), never the video itself.
      const img = document.createElement('img');
      img.src = url;
      img.className = 'img-fluid mod-media';
      img.alt = isVideo ? 'וידאו ממתין לאישור (תמונה מטושטשת)' : info.status === 'open' ? 'תמונה' : 'תמונה (חלקה מטושטש)';
      img.loading = 'lazy';
      img.addEventListener('load', () => fit(img.naturalWidth, img.naturalHeight));
      if (isVideo) img.style.cursor = 'default';
      frame.appendChild(img);
    }
    if (!isModerator && info.status === 'pending') {
      frame.appendChild(this.chip('בבדיקה'));
    }

    if (!isModerator) return;

    const bar = document.createElement('div');
    bar.className = 'mod-bar';
    const badge = document.createElement('span');
    badge.className = `mod-badge mod-${info.status}`;
    badge.textContent = BADGES[info.status] ?? info.status;
    badge.title = this.describe(info);
    bar.appendChild(badge);
    if (info.hold?.held) {
      const held = document.createElement('span');
      held.className = 'mod-badge mod-attention mod-held';
      held.textContent = 'ממתין לאישור פרסום · הקוראים לא רואים';
      held.title = 'הסרטון לא מוגש לקוראים עד שמאשר ילחץ "אשר פרסום" (ברשת הדמויות), אחרי שצפה בו כפי שהקוראים יראו.';
      bar.appendChild(held);
    } else if (info.hold?.approvedBy) {
      const ok = document.createElement('span');
      ok.className = 'mod-badge mod-approved';
      ok.textContent = 'אושר לפרסום';
      ok.title = `אושר על ידי ${info.hold.approvedBy} ${info.hold.approvedAt ? new Date(info.hold.approvedAt).toLocaleString('he-IL') : ''}`;
      bar.appendChild(ok);
    }
    if (info.unreviewed) {
      const un = document.createElement('span');
      un.className = 'mod-badge mod-attention';
      un.textContent = 'טרם נבדק: מטושטש לגמרי לקוראים';
      un.title = 'מצב "מחמיר עד בדיקת מנהל" פעיל. הקובץ יוצג לקוראים כרגיל רק אחרי שתפתח את "בדיקת דמויות" ותשמור.';
      bar.appendChild(un);
    }
    if (info.needsReview) {
      const why = (info.reviewReasons ?? []).map(r => REASONS[r] ?? r).join(', ');
      const flag = document.createElement('span');
      flag.className = 'mod-badge mod-attention';
      flag.textContent = `ממתין לבדיקת מנהל${why ? ': ' + why : ''}`;
      flag.title = 'הבדיקה האוטומטית לא יכולה להכריע בקובץ הזה. לחץ "בדיקת דמויות" כדי לאשר או לתקן.';
      bar.appendChild(flag);
    }
    if (info.likelyMen) {
      const likely = document.createElement('span');
      likely.className = 'mod-badge mod-attention';
      likely.textContent = `כנראה גבר: ${info.likelyMen}`;
      likely.title = 'דמויות מטושטשות שנראות כגברים (פנים ברורות במספר פריימים). הן ממתינות לאישור שלך ומופיעות ראשונות ברשת הדמויות.';
      bar.appendChild(likely);
    }

    if (info.manualBlur?.active) {
      const manual = document.createElement('span');
      manual.className = 'mod-badge mod-approved';
      manual.textContent = `טשטוש ידני פעיל (${info.manualBlur.shapes})`;
      manual.title = 'הקוראים מקבלים את הגרסה הזו: הטשטוש האוטומטי ועליו הצורות שסימנת.';
      bar.appendChild(manual);
    } else if (info.manualBlur?.stale) {
      const stale = document.createElement('span');
      stale.className = 'mod-badge mod-attention';
      stale.textContent = 'טשטוש ידני לא בתוקף';
      stale.title = 'התוצאה האוטומטית של התמונה השתנתה מאז שסימנת. הקוראים מקבלים את הגרסה האוטומטית. פתח את "טשטוש ידני" ושמור שוב כדי להחיל את הצורות.';
      bar.appendChild(stale);
    }

    for (const choice of CHOICES) {
      if (choice.status !== info.status) {
        bar.appendChild(this.button(choice.label, `mod-btn-${choice.status}`, wrap, info.id, choice.status));
      }
    }

    if (info.status !== 'pending' && info.canReview) {
      const review = document.createElement('button');
      review.type = 'button';
      review.className = 'mod-btn mod-btn-review' + (info.needsReview || info.likelyMen || info.unreviewed ? ' mod-btn-attention' : '');
      review.textContent = 'בדיקת דמויות';
      review.title = 'רשת הדמויות שזוהו בקובץ: אישור או תיקון לכל דמות (גבר / טשטש)';
      review.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.dialog.open(FigureReviewComponent, { context: { fileId: info.id }, closeOnBackdropClick: false })
          .onClose.subscribe(async (saved) => {
            if (saved) this.render(wrap, await this.getStatus(info.id, true), true);
          });
      });
      bar.appendChild(review);
    }

    if (info.status !== 'pending' && info.manualBlur && (info.manualBlur.available || info.manualBlur.shapes > 0)) {
      const manualBtn = document.createElement('button');
      manualBtn.type = 'button';
      manualBtn.className = 'mod-btn mod-btn-manual' + (info.manualBlur.stale ? ' mod-btn-attention' : '');
      manualBtn.textContent = 'טשטוש ידני';
      manualBtn.title = 'צייר מלבן או עיגול טשטוש על התמונה. הטשטוש מתווסף על הטשטוש האוטומטי ולא חושף שום דבר.';
      manualBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.dialog.open(ManualBlurComponent, { context: { fileId: info.id }, closeOnBackdropClick: false, closeOnEsc: false })
          .onClose.subscribe(async (saved) => {
            if (saved) this.render(wrap, await this.getStatus(info.id, true), true);
          });
      });
      bar.appendChild(manualBtn);
    }

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'mod-btn mod-btn-reprocess';
    again.textContent = 'בדוק מחדש';
    again.title = 'הרצת הבדיקה האוטומטית מחדש לפי רמת ההחמרה הנוכחית (מבטל החלטה ידנית)';
    again.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      again.disabled = true;
      try {
        await this.reprocess(info.id);
        this.render(wrap, await this.getStatus(info.id, true), true);
      } catch {
        again.disabled = false;
        alert('הבדיקה מחדש נכשלה');
      }
    });
    bar.appendChild(again);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mod-btn mod-btn-asreader' + (asReader ? ' mod-btn-attention' : '');
    toggle.textContent = asReader ? 'הצג מקור' : 'הצג כמו הקוראים';
    toggle.title = 'מחליף את התמונה/הסרטון כאן במה שהקוראים מקבלים (עם הטשטוש), כדי לראות את האפקט של התיקונים';
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      wrap.dataset['asReader'] = asReader ? '0' : '1';
      this.render(wrap, info, true);
    });
    bar.appendChild(toggle);

    const preview = document.createElement('a');
    preview.href = `${src}?view=public`;
    preview.target = '_blank';
    preview.className = 'mod-link';
    preview.textContent = 'תצוגת קורא';
    bar.appendChild(preview);
    wrap.appendChild(bar);
  }

  private chip(text: string) {
    const chip = document.createElement('span');
    chip.className = 'mod-chip';
    chip.textContent = text;
    return chip;
  }

  private button(label: string, cls: string, wrap: HTMLElement, id: string, status: ModerationChoice) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mod-btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      btn.disabled = true;
      try {
        await this.setStatus(id, status);
        const info = await this.getStatus(id, true);
        this.render(wrap, info, true);
      } catch {
        btn.disabled = false;
        alert('שינוי הסטטוס נכשל');
      }
    });
    return btn;
  }

  private describe(info: FileModeration): string {
    const lines: string[] = [];
    if (info.autoDecision) {
      const reasons = (info.autoReasons ?? []).map(r => REASONS[r] ?? r).join(', ');
      const decision = info.autoDecision === 'open' ? 'פתוח' : info.autoDecision === 'regional' ? 'טשטוש אזורי' : 'טשטוש מלא';
      const levels: Record<string, string> = { strict: 'מחמיר', normal: 'רגיל', lenient: 'מקל' };
      lines.push(`בדיקה אוטומטית${info.autoLevel ? ` (${levels[info.autoLevel] ?? info.autoLevel})` : ''}: ${decision} (${reasons}), ביטחון ${Math.round((info.autoConfidence ?? 0) * 100)}%`);
      if (info.autoRegions) lines.push(`דמויות מטושטשות: ${info.autoRegions}`);
      if (info.autoFullFrames) lines.push(`פריימים שטושטשו במלואם: ${info.autoFullFrames}`);
    } else {
      lines.push('בדיקה אוטומטית: טרם הסתיימה');
    }
    if (info.reviewedBy) {
      lines.push(`החלטה ידנית: ${info.reviewedBy} ${info.reviewedAt ? new Date(info.reviewedAt).toLocaleString('he-IL') : ''}`);
    }
    const readers = { original: 'המקור', regional: 'גרסה עם טשטוש אזורי', blurred: 'גרסה מטושטשת לגמרי', hidden: 'כלום (ממתין לאישור)', manual: 'גרסה עם טשטוש ידני' };
    lines.push(`קוראים רואים: ${readers[info.publicVariant ?? 'blurred']}`);
    return lines.join('\n');
  }
}
