import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, Subject } from 'rxjs';
import { ResponseResult } from '../models/response-result.model';
import { NbDialogService } from '@nebular/theme';
import { FigureReviewComponent } from '../components/admin/figure-review/figure-review.component';

export type ModerationStatus = 'pending' | 'open' | 'regional' | 'blurred';
export type ModerationChoice = 'open' | 'regional' | 'blurred';

export interface FileModeration {
  id: string;
  status: ModerationStatus;
  kind: string;
  /** What readers receive: the original, the regionally blurred version, or the fully blurred one. */
  publicVariant?: 'original' | 'regional' | 'blurred';
  autoRegions?: number;
  autoLevel?: string;
  autoFullFrames?: number;
  reviewedBy?: string;
  reviewedAt?: string;
  autoDecision?: string;
  autoReasons?: string[];
  autoConfidence?: number;
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
    const items = Array.from(container.querySelectorAll<HTMLElement>('img, video, .mod-wrap'));
    for (const el of items) {
      let wrap = el.classList.contains('mod-wrap') ? el : null;
      if (!wrap) {
        if (el.closest('.mod-wrap')) continue;
        const src = el.tagName === 'VIDEO' ? (el.querySelector('source')?.getAttribute('src') ?? el.getAttribute('src')) : el.getAttribute('src');
        const match = src?.match(FILE_URL);
        if (!src || !match) continue;
        wrap = document.createElement('div');
        wrap.className = 'mod-wrap';
        wrap.dataset['fileId'] = match[1];
        wrap.dataset['src'] = src.split('?')[0];
        wrap.dataset['tag'] = el.tagName.toLowerCase();
        el.replaceWith(wrap);
      }
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
    const url = `${src}?m=${info.status}-${variant}`;
    // Readers can play a video only when the server sends them a video (original or regionally blurred).
    const readerGetsVideo = variant !== 'blurred';
    wrap.replaceChildren();

    const frame = document.createElement('div');
    frame.className = 'mod-frame';
    wrap.appendChild(frame);

    if (isVideo && (isModerator || readerGetsVideo)) {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = url;
      video.className = 'mod-media';
      video.setAttribute('aria-label', 'וידאו');
      frame.appendChild(video);
    } else {
      // Readers of a fully blurred / pending video get the blurred poster (an image), never the video itself.
      const img = document.createElement('img');
      img.src = url;
      img.className = 'img-fluid mod-media';
      img.alt = isVideo ? 'וידאו ממתין לאישור (תמונה מטושטשת)' : info.status === 'open' ? 'תמונה' : 'תמונה (חלקה מטושטש)';
      img.loading = 'lazy';
      img.width = 300;
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

    for (const choice of CHOICES) {
      if (choice.status !== info.status) {
        bar.appendChild(this.button(choice.label, `mod-btn-${choice.status}`, wrap, info.id, choice.status));
      }
    }

    if (info.status !== 'pending') {
      const review = document.createElement('button');
      review.type = 'button';
      review.className = 'mod-btn mod-btn-review';
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
    const readers = { original: 'המקור', regional: 'גרסה עם טשטוש אזורי', blurred: 'גרסה מטושטשת לגמרי' };
    lines.push(`קוראים רואים: ${readers[info.publicVariant ?? 'blurred']}`);
    return lines.join('\n');
  }
}
