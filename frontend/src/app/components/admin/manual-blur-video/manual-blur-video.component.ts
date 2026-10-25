import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NbButtonModule, NbCardModule, NbDialogRef, NbToastrService } from '@nebular/theme';
import { HANDLES, Handle, Shape, ShapeType, fromDrag, hit, move, resize } from '../../../manual-blur-geometry';
import {
  Interp, MAX_KEYS, MAX_TRACKS, MAX_VIDEO_SEC, Track, TrackHistory, addTrack, boxAt, deleteKey, deleteTrack, formatTime, fromServer, nearestKey, sameTracks,
  setEnd, setInterp, setKey, toRequest,
} from '../../../manual-blur-video-model';

interface ManualVideoState {
  available: boolean;
  reason?: string;
  base?: 'original' | 'regional';
  tracks: unknown;
  active?: boolean;
  job?: { state: string; percent?: number; error?: string };
}

type Tool = 'select' | ShapeType;

const FRAME = 1 / 30;   // one step of the frame buttons (the page does not know the exact frame rate)

const UNAVAILABLE: Record<string, string> = {
  fully_blurred: 'הסרטון מטושטש לגמרי לקוראים. טשטוש נוסף לא משנה כלום: כדי לשחרר חלק ממנו, הפוך אותו קודם ל"טשטוש אזורי".',
  unreviewed: 'הסרטון ממתין לבדיקת מנהל (מצב "מחמיר עד בדיקת מנהל"). עד שתפתח את "בדיקת דמויות" ותשמור, הקוראים לא רואים אותו.',
  no_regional_version: 'עדיין אין גרסת טשטוש אזורי לסרטון הזה. לחץ "בדוק מחדש" והמתן לסיום הבדיקה.',
  unsupported_format: 'הקובץ הזה לא נתמך בכלי.',
  not_image: 'הכלי עובד על תמונות וסרטונים בלבד.',
};

/**
 * The manual blur editor for videos (MANUAL_BLUR_VIDEO, owners and approvers). The video plays here with a layer on top: draw a rectangle or an
 * ellipse at a second of the video, move it to another second and change it there (that is a keyframe: between keyframes the box moves smoothly),
 * choose where the blur ends. The blur is ADDED to what the automatic check already hides. Saving starts a render on the server (seconds to
 * minutes); this window shows its progress. The preview here is an approximation: what readers get is rendered by the server.
 */
@Component({
  selector: 'app-manual-blur-video',
  imports: [NbCardModule, NbButtonModule],
  templateUrl: './manual-blur-video.component.html',
  styleUrl: './manual-blur-video.component.scss'
})
export class ManualBlurVideoComponent implements OnInit, OnDestroy {
  fileId = '';
  loading = true;
  saving = false;
  available = false;
  reason = '';
  base: 'original' | 'regional' = 'original';
  videoUrl = '';
  loadError = false;
  staleNotice = false;
  tooLong = false;

  tracks: Track[] = [];
  saved: Track[] = [];
  selected = -1;
  tool: Tool = 'rect';
  previewOn = false;
  muted = true;
  playing = false;
  time = 0;
  duration = 0;
  draft: Shape | null = null;
  confirmClose = false;
  message = '';
  /** The render that is running (or has just failed), shown instead of the editor. */
  job: { state: string; percent: number; error?: string } | null = null;

  readonly handles = HANDLES;
  readonly maxTracks = MAX_TRACKS;

  private history = new TrackHistory([]);
  private drag: { mode: 'draw' | 'move' | 'resize'; x0: number; y0: number; startTracks: Track[]; startBox?: Shape; handle?: Handle; idx: number; changed: boolean } | null = null;
  private tlDrag: { kind: 'seek' | 'end'; idx: number } | null = null;
  private raf = 0;
  private clock = 0;
  private poll: ReturnType<typeof setInterval> | null = null;

  @ViewChild('stage') stage?: ElementRef<HTMLDivElement>;
  @ViewChild('video') video?: ElementRef<HTMLVideoElement>;
  @ViewChild('preview') preview?: ElementRef<HTMLCanvasElement>;
  @ViewChild('timeline') timeline?: ElementRef<HTMLDivElement>;

  constructor(public dialogRef: NbDialogRef<ManualBlurVideoComponent>, private http: HttpClient, private toastr: NbToastrService) { }

  async ngOnInit() {
    try {
      const st = await this.load();
      if (st.job && (st.job.state === 'rendering' || st.job.state === 'queued')) this.startPolling();
      // view=base: the video readers get from the automatic check, without the manual blur (what the boxes are drawn on)
      this.videoUrl = `/api/files/${this.fileId}?view=base`;
    } catch {
      this.message = 'טעינת הכלי נכשלה';
    } finally {
      this.loading = false;
    }
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.clock);
    this.stopPolling();
  }

  private async load(): Promise<ManualVideoState> {
    const st = await firstValueFrom(this.http.get<ManualVideoState>(`/api/admin/files/${this.fileId}/manual-blur`));
    this.available = !!st.available;
    this.reason = st.reason ?? '';
    this.base = st.base ?? 'original';
    const list = fromServer(st.tracks);
    this.staleNotice = list.length > 0 && st.active === false;
    this.tracks = list;
    this.saved = list;
    this.history = new TrackHistory(list);
    if (st.job && (st.job.state === 'rendering' || st.job.state === 'queued')) this.job = { state: st.job.state, percent: st.job.percent ?? 0 };
    return st;
  }

  get baseLabel() { return this.base === 'regional' ? 'הטשטוש האזורי האוטומטי' : 'הסרטון המקורי'; }
  get unavailableText() { return UNAVAILABLE[this.reason] ?? 'הכלי לא זמין לסרטון הזה.'; }
  get dirty() { return !sameTracks(this.tracks, this.saved); }
  get canUndo() { return this.history.canUndo; }
  get canRedo() { return this.history.canRedo; }
  get timeText() { return `${formatTime(this.time)} / ${formatTime(this.duration)}`; }
  get rendering() { return !!this.job && (this.job.state === 'rendering' || this.job.state === 'queued'); }
  get percent() { return Math.max(0, Math.min(100, this.job?.percent ?? 0)); }
  get sel(): Track | null { return this.tracks[this.selected] ?? null; }
  get selKeyIdx() { return this.sel ? nearestKey(this.sel, this.time) : -1; }
  get canEnd() { const s = this.sel; return !!s && this.time >= s.keys[s.keys.length - 1].t; }
  get keyCount() { return this.tracks.reduce((n, t) => n + t.keys.length, 0); }

  /** The boxes shown on the picture at this second: the tracks that are active now (without the padding the renderer adds). */
  get boxes(): { idx: number; box: Shape }[] {
    const out: { idx: number; box: Shape }[] = [];
    this.tracks.forEach((tr, idx) => { const b = boxAt(tr, this.time, 0); if (b) out.push({ idx, box: b }); });
    return out;
  }

  // ---- the video ----

  onLoadedMetadata() {
    const v = this.video!.nativeElement;
    this.duration = v.duration || 0;
    this.tooLong = this.duration > MAX_VIDEO_SEC;
    this.loadError = false;
    this.schedulePreview();
  }

  onVideoError() { this.loadError = true; }

  togglePlay() {
    const v = this.video?.nativeElement;
    if (!v) return;
    if (v.paused) { v.play().catch(() => { /* the browser may refuse; the buttons stay */ }); } else { v.pause(); }
  }

  onPlay() {
    this.playing = true;
    this.tick();
  }

  onPause() {
    this.playing = false;
    cancelAnimationFrame(this.clock);
    this.syncTime();
  }

  /** While the video plays the time follows it frame by frame (the page needs it for the boxes and the preview). */
  private tick() {
    const v = this.video?.nativeElement;
    if (!v) return;
    this.syncTime();
    if (this.playing) this.clock = requestAnimationFrame(() => this.tick());
  }

  syncTime() {
    const v = this.video?.nativeElement;
    if (!v) return;
    this.time = v.currentTime;
    this.schedulePreview();
  }

  seek(t: number) {
    const v = this.video?.nativeElement;
    if (!v || !this.duration) return;
    v.currentTime = Math.min(this.duration, Math.max(0, t));
    this.time = v.currentTime;
  }

  step(frames: number) {
    this.video?.nativeElement.pause();
    this.seek(this.time + frames * FRAME);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.video) this.video.nativeElement.muted = this.muted;
  }

  // ---- tools ----

  setTool(t: Tool) {
    this.tool = t;
    if (t !== 'select') this.selected = -1;
  }

  togglePreview() {
    this.previewOn = !this.previewOn;
    this.schedulePreview();
  }

  undo() { this.tracks = this.history.undo(); this.afterChange(); }
  redo() { this.tracks = this.history.redo(); this.afterChange(); }

  private commit(next: Track[]) {
    this.tracks = next;
    this.history.push(next);
    this.afterChange();
  }

  private afterChange() {
    if (this.selected >= this.tracks.length) this.selected = -1;
    this.message = '';
    this.schedulePreview();
  }

  deleteKeyframe() {
    if (!this.sel || this.selKeyIdx < 0) return;
    const idx = this.selected;
    const gone = this.sel.keys.length <= 1;
    this.commit(deleteKey(this.tracks, idx, this.selKeyIdx));
    if (gone) this.selected = -1;
  }

  deleteSelectedTrack() {
    if (this.selected < 0) return;
    this.commit(deleteTrack(this.tracks, this.selected));
    this.selected = -1;
  }

  clearAll() {
    if (!this.tracks.length) return;
    this.commit([]);
    this.selected = -1;
  }

  endHere() {
    if (this.selected < 0) return;
    const next = setEnd(this.tracks, this.selected, this.time);
    if (!next) { this.message = 'הסיום חייב להיות אחרי נקודת המפתח האחרונה של הטשטוש'; return; }
    this.commit(next);
  }

  endAtVideoEnd() {
    if (this.selected < 0) return;
    const next = setEnd(this.tracks, this.selected, null);
    if (next) this.commit(next);
  }

  setInterpolation(i: Interp) {
    if (this.selected < 0) return;
    this.commit(setInterp(this.tracks, this.selected, i));
  }

  selectTrack(i: number, seekToStart = false) {
    this.tool = 'select';
    this.selected = i;
    if (seekToStart && this.tracks[i]) this.seek(this.tracks[i].keys[0].t);
  }

  gotoKey(i: number, k: number) {
    this.selectTrack(i);
    this.video?.nativeElement.pause();
    this.seek(this.tracks[i].keys[k].t);
  }

  // ---- the layer on the picture (mouse, pen, touch) ----

  private point(ev: PointerEvent) {
    const r = this.stage!.nativeElement.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
  }

  onPointerDown(ev: PointerEvent) {
    if (!this.stage || ev.button > 0 || !this.duration) return;
    this.confirmClose = false;
    const p = this.point(ev);
    const handle = (ev.target as HTMLElement).dataset?.['handle'] as Handle | undefined;
    const el = this.stage.nativeElement;
    const shown = this.boxes;
    if (handle && this.selected >= 0) {
      const b = boxAt(this.tracks[this.selected], this.time, 0);
      if (!b) return;
      this.drag = { mode: 'resize', x0: p.x, y0: p.y, startTracks: this.tracks, startBox: b, handle, idx: this.selected, changed: false };
    } else if (this.tool === 'select') {
      const i = hit(shown.map(s => s.box), p.x, p.y);
      if (i < 0) { this.selected = -1; return; }
      this.selected = shown[i].idx;
      this.video?.nativeElement.pause();
      this.drag = { mode: 'move', x0: p.x, y0: p.y, startTracks: this.tracks, startBox: shown[i].box, idx: shown[i].idx, changed: false };
    } else {
      if (this.tracks.length >= MAX_TRACKS) { this.message = `אפשר עד ${MAX_TRACKS} טשטושים בסרטון`; return; }
      this.video?.nativeElement.pause();
      this.selected = -1;
      this.drag = { mode: 'draw', x0: p.x, y0: p.y, startTracks: this.tracks, idx: -1, changed: false };
    }
    el.setPointerCapture(ev.pointerId);
    el.focus({ preventScroll: true });
    ev.preventDefault();
  }

  onPointerMove(ev: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const p = this.point(ev);
    if (d.mode === 'draw') {
      this.draft = fromDrag(this.tool as ShapeType, d.x0, d.y0, p.x, p.y);
    } else if (d.startBox) {
      const dx = p.x - d.x0, dy = p.y - d.y0;
      const box = d.mode === 'move' ? move(d.startBox, dx, dy) : resize(d.startBox, d.handle!, dx, dy);
      const next = setKey(d.startTracks, d.idx, this.time, box);   // the box at THIS second is a keyframe
      if (next) { this.tracks = next; d.changed = true; }
      else this.message = `אי אפשר יותר מ-${MAX_KEYS} נקודות מפתח בטשטוש אחד`;
    }
    this.schedulePreview();
  }

  onPointerUp(ev: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.stage?.nativeElement.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    if (d.mode === 'draw') {
      const s = this.draft;
      this.draft = null;
      if (s) {
        const next = addTrack(this.tracks, s, this.time);
        if (next) { this.commit(next); this.selected = this.tracks.length - 1; }
      }
    } else if (d.changed) {
      this.history.push(this.tracks);
    }
    this.afterChange();
  }

  onPointerCancel() {
    const d = this.drag;
    this.drag = null;
    this.draft = null;
    if (d && d.mode !== 'draw') this.tracks = d.startTracks;
    this.afterChange();
  }

  selectByFocus(i: number) {
    if (this.tool !== 'select') this.tool = 'select';
    this.selected = i;
  }

  // ---- the timeline ----

  pct(t: number) { return this.duration ? Math.min(100, Math.max(0, (t / this.duration) * 100)) : 0; }

  /** The ticks of the ruler: every second for short videos, every 5 / 10 / 30 / 60 s for long ones. */
  get ticks(): { t: number; label: string | null }[] {
    if (!this.duration) return [];
    const stepSec = this.duration <= 40 ? 1 : this.duration <= 120 ? 5 : this.duration <= 400 ? 10 : 30;
    const out: { t: number; label: string | null }[] = [];
    for (let t = 0; t <= this.duration + 1e-6; t += stepSec) out.push({ t, label: t % (stepSec * (stepSec === 1 ? 5 : 2)) === 0 ? formatTime(t).replace(/\.0$/, '') : null });
    return out;
  }

  trackEnd(tr: Track) { return tr.end ?? this.duration; }

  private timelineTime(ev: PointerEvent) {
    const r = this.timeline!.nativeElement.getBoundingClientRect();
    return Math.min(this.duration, Math.max(0, ((ev.clientX - r.left) / r.width) * this.duration));
  }

  onTimelineDown(ev: PointerEvent, kind: 'seek' | 'end' = 'seek', idx = -1) {
    if (!this.duration || ev.button > 0) return;
    this.confirmClose = false;
    this.tlDrag = { kind, idx };
    this.timeline!.nativeElement.setPointerCapture(ev.pointerId);
    if (kind === 'seek') { this.video?.nativeElement.pause(); this.seek(this.timelineTime(ev)); }
    ev.preventDefault();
    ev.stopPropagation();
  }

  onTimelineMove(ev: PointerEvent) {
    const d = this.tlDrag;
    if (!d) return;
    if (d.kind === 'seek') { this.seek(this.timelineTime(ev)); return; }
    const t = this.timelineTime(ev);
    const next = setEnd(this.tracks, d.idx, t);
    if (next) this.tracks = next;
    this.schedulePreview();
  }

  onTimelineUp(ev: PointerEvent) {
    const d = this.tlDrag;
    this.tlDrag = null;
    try { this.timeline?.nativeElement.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    if (d?.kind === 'end') this.history.push(this.tracks);
    this.afterChange();
  }

  // ---- keyboard ----

  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent) {
    if (this.loading || !this.available || this.saving || this.rendering) return;
    const tag = (ev.target as HTMLElement)?.tagName;
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); ev.shiftKey ? this.redo() : this.undo(); }
    else if (mod && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); this.redo(); }
    else if (ev.key === ' ' && tag !== 'BUTTON' && tag !== 'SELECT') { ev.preventDefault(); this.togglePlay(); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const dir = ev.key === 'ArrowRight' ? 1 : -1;
      if (ev.shiftKey) { this.video?.nativeElement.pause(); this.seek(this.time + dir); } else this.step(dir);
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.selected >= 0) {
      ev.preventDefault();
      if (this.selKeyIdx >= 0) this.deleteKeyframe(); else this.deleteSelectedTrack();
    } else if (ev.key === 'Escape') {
      if (this.selected >= 0 || this.draft) { this.selected = -1; this.onPointerCancel(); } else this.close();
    }
  }

  // ---- preview (an approximation of the server's pixelation, drawn over the video in the browser) ----

  private schedulePreview() {
    if (!this.previewOn) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.drawPreview());
  }

  private drawPreview() {
    const video = this.video?.nativeElement, canvas = this.preview?.nativeElement;
    if (!video || !canvas || !video.videoWidth) return;
    const W = Math.min(1280, Math.round(video.clientWidth || video.videoWidth)), H = Math.round(W * video.videoHeight / video.videoWidth);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const tiny = document.createElement('canvas');
    const tctx = tiny.getContext('2d');
    if (!tctx) return;
    for (const { box: s } of this.boxes) {
      const dx = s.x * W, dy = s.y * H, dw = s.w * W, dh = s.h * H;
      if (dw < 2 || dh < 2) continue;
      const scale = 6 / Math.min(dw, dh);   // 6 blocks across the shorter side, as the server does
      tiny.width = Math.max(1, Math.round(dw * scale));
      tiny.height = Math.max(1, Math.round(dh * scale));
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(video, s.x * video.videoWidth, s.y * video.videoHeight, s.w * video.videoWidth, s.h * video.videoHeight, 0, 0, tiny.width, tiny.height);
      ctx.save();
      if (s.type === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(dx + dw / 2, dy + dh / 2, dw / 2, dh / 2, 0, 0, Math.PI * 2);
        ctx.clip();
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, dx, dy, dw, dh);
      ctx.restore();
    }
  }

  // ---- save / render ----

  async save() {
    if (this.saving || this.rendering || !this.dirty || this.tooLong) return;
    this.saving = true;
    this.message = '';
    try {
      const res = await firstValueFrom(this.http.post<{ state?: string }>(`/api/admin/files/${this.fileId}/manual-blur`, { tracks: toRequest(this.tracks) }, { observe: 'response' }));
      if (res.status === 202) {
        this.video?.nativeElement.pause();
        this.job = { state: res.body?.state ?? 'queued', percent: 0 };
        this.startPolling();
      } else {   // no tracks: the manual blur was removed at once
        this.toastr.success('', 'הטשטוש הידני הוסר');
        this.dialogRef.close(true);
      }
    } catch (e) {
      this.message = this.errorText(e);
    } finally {
      this.saving = false;
    }
  }

  private startPolling() {
    this.stopPolling();
    const once = async () => {
      try {
        const st = await firstValueFrom(this.http.get<ManualVideoState>(`/api/admin/files/${this.fileId}/manual-blur`));
        const j = st.job;
        if (!j) return;
        if (j.state === 'done') {
          this.stopPolling();
          this.toastr.success('', 'הטשטוש הידני נשמר והקוראים יקבלו אותו');
          this.dialogRef.close(true);
        } else if (j.state === 'failed' || j.state === 'cancelled') {
          this.stopPolling();
          this.job = null;
          this.message = j.state === 'cancelled' ? 'הרינדור בוטל' : this.renderError(j.error);
        } else {
          this.job = { state: j.state, percent: j.percent ?? 0 };
        }
      } catch { /* the next poll tries again */ }
    };
    this.poll = setInterval(once, 1000);
  }

  private stopPolling() {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
  }

  private renderError(err?: string): string {
    if (err && /stale/.test(err)) return 'התוצאה האוטומטית של הסרטון השתנתה בזמן הרינדור. פתח את הכלי שוב ושמור.';
    if (err && /time after the end/.test(err)) return 'אחת מנקודות המפתח אחרי סוף הסרטון. תקן ושמור שוב.';
    if (err && /self_check/.test(err)) return 'הרינדור נכשל בבדיקה העצמית ולכן לא פורסם. נסה שוב, ואם זה חוזר, דווח.';
    return 'הרינדור נכשל, וההגדרות הקודמות נשארו כמו שהיו. אפשר לנסות שוב.';
  }

  private errorText(e: unknown): string {
    const err = e as HttpErrorResponse;
    const detail = typeof err?.error === 'string' ? err.error.trim() : '';
    switch (err?.status) {
      case 409: return 'התוצאה האוטומטית של הסרטון השתנתה בינתיים. סגור ופתח את הכלי שוב.';
      case 503: return 'שירות הטשטוש לא זמין כרגע. נסה שוב בעוד רגע.';
      case 400: return `הנתונים לא תקינים: ${detail}`;
      case 401: return 'אין לך הרשאה לכלי הזה.';
      default: return 'השמירה נכשלה. נסה שוב.';
    }
  }

  close() {
    if (this.dirty && !this.confirmClose && !this.rendering) {
      this.confirmClose = true;   // inline question instead of a browser dialog
      return;
    }
    this.dialogRef.close(false);
  }

  keepEditing() { this.confirmClose = false; }
  isSelected(i: number) { return i === this.selected; }
  trackLabel(i: number) { return `${this.tracks[i].type === 'ellipse' ? 'עיגול' : 'מלבן'} ${i + 1}`; }
}
