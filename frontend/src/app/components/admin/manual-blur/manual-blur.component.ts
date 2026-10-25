import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NbButtonModule, NbCardModule, NbDialogRef, NbToastrService } from '@nebular/theme';
import {
  Handle, HANDLES, History, MAX_SHAPES, Shape, ShapeType, fromDrag, fromServer, hit, move, nudge, resize, sameShapes, toRequest,
} from '../../../manual-blur-geometry';

interface ManualBlurState {
  available: boolean;
  reason?: string;
  base?: 'original' | 'regional';
  shapes: unknown;
  active?: boolean;
}

type Tool = 'select' | ShapeType;

const UNAVAILABLE: Record<string, string> = {
  unsupported_format: 'הכלי עובד על תמונות רגילות (JPEG, PNG, WebP). לא על תמונות מונפשות (GIF).',
  not_image: 'הכלי עובד על תמונות בלבד.',
};

/**
 * The manual blur editor (MANUAL_BLUR, owners and approvers): draw rectangles / ellipses on a picture, move and resize them, delete them.
 * The blur is ADDED to what the automatic check already hides; nothing is revealed. Shapes are kept as shares of the picture, so they
 * do not depend on the size the picture is shown at. The preview here is an approximation: what readers get is rendered by the server.
 */
@Component({
  selector: 'app-manual-blur',
  imports: [NbCardModule, NbButtonModule],
  templateUrl: './manual-blur.component.html',
  styleUrl: './manual-blur.component.scss'
})
export class ManualBlurComponent implements OnInit, OnDestroy {
  fileId = '';
  loading = true;
  saving = false;
  available = false;
  reason = '';
  base: 'original' | 'regional' = 'original';
  imgUrl = '';
  imgError = false;
  /** There is a saved manual blur that no longer applies (the automatic result changed since): its shapes are loaded so they can be saved again. */
  staleNotice = false;

  shapes: Shape[] = [];
  saved: Shape[] = [];
  selected = -1;
  tool: Tool = 'rect';
  previewOn = false;
  draft: Shape | null = null;
  confirmClose = false;
  /** Saving shows the question first: the readers get the original with ONLY the shapes blurred. */
  confirmSave = false;
  message = '';

  readonly handles = HANDLES;
  readonly maxShapes = MAX_SHAPES;

  private history = new History([]);
  private drag: { mode: 'draw' | 'move' | 'resize'; x0: number; y0: number; start?: Shape; handle?: Handle; changed: boolean } | null = null;
  private raf = 0;

  @ViewChild('stage') stage?: ElementRef<HTMLDivElement>;
  @ViewChild('img') img?: ElementRef<HTMLImageElement>;
  @ViewChild('preview') preview?: ElementRef<HTMLCanvasElement>;

  constructor(public dialogRef: NbDialogRef<ManualBlurComponent>, private http: HttpClient, private toastr: NbToastrService) { }

  async ngOnInit() {
    try {
      const st = await firstValueFrom(this.http.get<ManualBlurState>(`/api/admin/files/${this.fileId}/manual-blur`));
      this.available = !!st.available;
      this.reason = st.reason ?? '';
      this.base = st.base ?? 'original';
      const list = fromServer(st.shapes);
      this.staleNotice = list.length > 0 && st.active === false;
      this.shapes = list;
      this.saved = list;
      this.history = new History(list);
      // the original (a moderator gets it without any ?view): the shapes are drawn on it, from scratch
      this.imgUrl = `/api/files/${this.fileId}?t=${Date.now()}`;
    } catch {
      this.message = 'טעינת הכלי נכשלה';
    } finally {
      this.loading = false;
    }
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.raf);
  }

  get baseLabel() {
    return 'התמונה המקורית';
  }

  get unavailableText() {
    return UNAVAILABLE[this.reason] ?? 'הכלי לא זמין לתמונה הזו.';
  }

  get dirty() {
    return !sameShapes(this.shapes, this.saved);
  }

  get canUndo() { return this.history.canUndo; }
  get canRedo() { return this.history.canRedo; }

  // ---- tools ----

  setTool(t: Tool) {
    this.tool = t;
    if (t !== 'select') this.selected = -1;
  }

  togglePreview() {
    this.previewOn = !this.previewOn;
    this.schedulePreview();
  }

  undo() { this.shapes = this.history.undo(); this.afterChange(); }
  redo() { this.shapes = this.history.redo(); this.afterChange(); }

  deleteSelected() {
    if (this.selected < 0) return;
    this.commit(this.shapes.filter((_, i) => i !== this.selected));
    this.selected = -1;
  }

  clearAll() {
    if (!this.shapes.length) return;
    this.commit([]);
    this.selected = -1;
  }

  private commit(next: Shape[]) {
    this.shapes = next;
    this.history.push(next);
    this.afterChange();
  }

  private afterChange() {
    if (this.selected >= this.shapes.length) this.selected = -1;
    this.message = '';
    this.schedulePreview();
  }

  // ---- pointer (mouse, pen, touch) ----

  private point(ev: PointerEvent): { x: number; y: number } {
    const r = this.stage!.nativeElement.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
  }

  onPointerDown(ev: PointerEvent) {
    if (!this.stage || ev.button > 0) return;
    this.confirmClose = false;
    const p = this.point(ev);
    const handle = (ev.target as HTMLElement).dataset?.['handle'] as Handle | undefined;
    const el = this.stage.nativeElement;
    if (handle && this.selected >= 0) {
      this.drag = { mode: 'resize', x0: p.x, y0: p.y, start: this.shapes[this.selected], handle, changed: false };
    } else if (this.tool === 'select') {
      const i = hit(this.shapes, p.x, p.y);
      this.selected = i;
      if (i < 0) return;
      this.drag = { mode: 'move', x0: p.x, y0: p.y, start: this.shapes[i], changed: false };
    } else {
      if (this.shapes.length >= MAX_SHAPES) {
        this.message = `אפשר עד ${MAX_SHAPES} צורות בתמונה`;
        return;
      }
      this.selected = -1;
      this.drag = { mode: 'draw', x0: p.x, y0: p.y, changed: false };
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
      const s = fromDrag(this.tool as ShapeType, d.x0, d.y0, p.x, p.y);
      this.draft = s;
      d.changed = true;
    } else if (this.selected >= 0 && d.start) {
      const dx = p.x - d.x0, dy = p.y - d.y0;
      const next = d.mode === 'move' ? move(d.start, dx, dy) : resize(d.start, d.handle!, dx, dy);
      this.shapes = this.shapes.map((s, i) => (i === this.selected ? next : s));
      d.changed = true;
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
        this.commit([...this.shapes, s]);
        this.selected = this.shapes.length - 1;
      }
    } else if (d.changed) {
      this.history.push(this.shapes);
    }
    this.afterChange();
  }

  onPointerCancel() {
    const d = this.drag;
    this.drag = null;
    this.draft = null;
    if (d?.start && this.selected >= 0) {
      this.shapes = this.shapes.map((s, i) => (i === this.selected ? d.start! : s));
    }
    this.afterChange();
  }

  /** Focusing a shape with the keyboard selects it. */
  selectShape(i: number) {
    if (this.tool !== 'select') this.tool = 'select';
    this.selected = i;
  }

  // ---- keyboard ----

  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent) {
    if (this.loading || !this.available || this.saving) return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      ev.shiftKey ? this.redo() : this.undo();
    } else if (mod && (ev.key === 'y' || ev.key === 'Y')) {
      ev.preventDefault();
      this.redo();
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.selected >= 0) {
      ev.preventDefault();
      this.deleteSelected();
    } else if (ev.key === 'Escape') {
      if (this.selected >= 0 || this.draft) { this.selected = -1; this.onPointerCancel(); } else this.close();
    } else if (this.selected >= 0 && ev.key.startsWith('Arrow')) {
      const step = ev.shiftKey ? 0.02 : 0.004;
      const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
      const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      ev.preventDefault();
      this.commit(this.shapes.map((s, i) => (i === this.selected ? nudge(s, dx, dy) : s)));
    }
  }

  // ---- preview (an approximation of the server's pixelation, drawn in the browser) ----

  onImgLoad() {
    this.imgError = false;
    this.schedulePreview();
  }

  onImgError() {
    this.imgError = true;
  }

  private schedulePreview() {
    if (!this.previewOn) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.drawPreview());
  }

  private drawPreview() {
    const img = this.img?.nativeElement, canvas = this.preview?.nativeElement;
    if (!img || !canvas || !img.naturalWidth) return;
    const W = Math.min(1600, Math.round(img.clientWidth || img.naturalWidth)), H = Math.round(W * img.naturalHeight / img.naturalWidth);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const tiny = document.createElement('canvas');
    const tctx = tiny.getContext('2d');
    if (!tctx) return;
    for (const s of this.shapes) {
      const dx = s.x * W, dy = s.y * H, dw = s.w * W, dh = s.h * H;
      const scale = 6 / Math.min(dw, dh);   // 6 blocks across the shorter side, as the server does
      tiny.width = Math.max(1, Math.round(dw * scale));
      tiny.height = Math.max(1, Math.round(dh * scale));
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(img, s.x * img.naturalWidth, s.y * img.naturalHeight, s.w * img.naturalWidth, s.h * img.naturalHeight, 0, 0, tiny.width, tiny.height);
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

  // ---- save / close ----

  /** The first click on "save": the moderator confirms what readers will see (everything outside the shapes). Removing the manual blur needs no question. */
  askSave() {
    if (this.saving || !this.dirty) return;
    if (this.shapes.length) { this.confirmSave = true; this.confirmClose = false; } else { void this.save(); }
  }

  cancelSave() { this.confirmSave = false; }

  async save() {
    this.confirmSave = false;
    if (this.saving || !this.dirty) return;
    this.saving = true;
    this.message = '';
    try {
      await firstValueFrom(this.http.post(`/api/admin/files/${this.fileId}/manual-blur`, { shapes: toRequest(this.shapes) }));
      this.toastr.success('', this.shapes.length ? 'הטשטוש הידני נשמר והקוראים יקבלו אותו' : 'הטשטוש הידני הוסר');
      this.dialogRef.close(true);
    } catch (e) {
      this.message = this.errorText(e);
      this.saving = false;
    }
  }

  private errorText(e: unknown): string {
    const err = e as HttpErrorResponse;
    const detail = typeof err?.error === 'string' ? err.error.trim() : '';
    switch (err?.status) {
      case 409: return 'התוצאה האוטומטית של התמונה השתנתה בינתיים. סגור ופתח את הכלי שוב.';
      case 422: return `השרת לא הצליח לצייר: ${detail || 'התמונה לא נתמכת'}`;
      case 503: return 'שירות הטשטוש לא זמין כרגע. נסה שוב בעוד רגע.';
      case 400: return `הצורות לא תקינות: ${detail}`;
      case 401: return 'אין לך הרשאה לכלי הזה.';
      default: return 'השמירה נכשלה. נסה שוב.';
    }
  }

  close() {
    if (this.dirty && !this.confirmClose) {
      this.confirmClose = true;   // inline question instead of a browser dialog
      return;
    }
    this.dialogRef.close(false);
  }

  keepEditing() {
    this.confirmClose = false;
  }

  /** For the template: is this shape the selected one. */
  isSelected(i: number) {
    return i === this.selected;
  }
}
