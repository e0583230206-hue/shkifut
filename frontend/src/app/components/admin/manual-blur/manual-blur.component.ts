import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NbButtonModule, NbCardModule, NbDialogRef, NbToastrService } from '@nebular/theme';
import {
  Handle, HANDLES, History, MAX_SHAPES, MAX_BRUSH_POINTS, Shape, ShapeType, fromDrag, fromServer, hit, move, nudge, resize, sameShapes, simplifyStroke, toRequest,
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
  /** The brush: its size (a share of the width of the picture), the stroke being painted, and where the pointer is (for the ring that shows the size). */
  brushSize = 0.04;
  stroke: [number, number][] | null = null;
  hover: { x: number; y: number } | null = null;
  confirmClose = false;
  /** Saving shows the question first: the readers get the original with ONLY the shapes blurred. */
  confirmSave = false;
  message = '';

  readonly handles = HANDLES;
  readonly maxShapes = MAX_SHAPES;

  private history = new History([]);
  private drag: { mode: 'draw' | 'move' | 'resize' | 'brush'; x0: number; y0: number; start?: Shape; handle?: Handle; changed: boolean } | null = null;
  private raf = 0;
  private observer?: ResizeObserver;

  @ViewChild('stage') stage?: ElementRef<HTMLDivElement>;
  @ViewChild('img') img?: ElementRef<HTMLImageElement>;
  @ViewChild('preview') preview?: ElementRef<HTMLCanvasElement>;
  @ViewChild('layer') layer?: ElementRef<HTMLCanvasElement>;

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
    this.observer?.disconnect();
  }

  /** Width / height of the picture as it is shown (a brush is round: its size is a share of the width). */
  get aspect() {
    const r = this.stage?.nativeElement.getBoundingClientRect();
    return r && r.height ? r.width / r.height : 1;
  }

  get selectedBrush(): Shape | null {
    const s = this.shapes[this.selected];
    return s && s.type === 'brush' ? s : null;
  }

  /** The stroke the slider changes: the selected one, but never while the brush tool is on (then the slider is for the next stroke). */
  private get sizeTarget(): Shape | null { return this.tool === 'brush' ? null : this.selectedBrush; }

  /** The size the slider shows: of the selected stroke, or of the next one. */
  get currentBrushSize() { return this.sizeTarget?.r ?? this.brushSize; }

  get currentBrushPx() {
    const w = this.stage?.nativeElement.getBoundingClientRect().width ?? 0;
    return Math.round(this.currentBrushSize * w * 2);
  }

  onSizeInput(v: string) {
    const r = Math.min(0.15, Math.max(0.01, Number(v)));
    if (!Number.isFinite(r)) return;
    if (this.sizeTarget) this.shapes = this.shapes.map((s, i) => (i === this.selected ? { ...s, r } : s));
    else this.brushSize = r;
    this.afterChange();
  }

  /** The slider was let go: the new size of a selected stroke is one step of the undo history. */
  onSizeChange() {
    if (this.sizeTarget) this.history.push(this.shapes);
    this.brushSize = this.sizeTarget?.r ?? this.brushSize;
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
    this.drawLayer();
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
    this.drawLayer();
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
      const i = hit(this.shapes, p.x, p.y, this.aspect);
      this.selected = i;
      this.drawLayer();
      if (i < 0) return;
      this.drag = { mode: 'move', x0: p.x, y0: p.y, start: this.shapes[i], changed: false };
    } else if (this.tool === 'brush') {
      if (this.shapes.length >= MAX_SHAPES) {
        this.message = `אפשר עד ${MAX_SHAPES} צורות בתמונה`;
        return;
      }
      this.selected = -1;
      this.stroke = [[p.x, p.y]];   // a tap makes a dot
      this.drag = { mode: 'brush', x0: p.x, y0: p.y, changed: false };
      this.drawLayer();
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
    if (!d) {   // no button down: only the ring of the brush follows the pointer
      if (this.tool === 'brush' && this.stage) { this.hover = this.point(ev); this.drawLayer(); }
      return;
    }
    const p = this.point(ev);
    if (d.mode === 'brush' && this.stroke) {
      const last = this.stroke[this.stroke.length - 1];
      if (Math.hypot(p.x - last[0], (p.y - last[1]) / this.aspect) > 0.0015 && this.stroke.length < MAX_BRUSH_POINTS * 4) this.stroke.push([p.x, p.y]);
      this.hover = p;
      this.drawLayer();
      return;
    }
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
    if (d.mode === 'brush') {
      const pts = this.stroke ? simplifyStroke(this.stroke, 0.0015, this.aspect) : [];
      this.stroke = null;
      if (pts.length) {
        this.commit([...this.shapes, { type: 'brush', x: 0, y: 0, w: 0, h: 0, r: this.brushSize, pts }]);
        this.selected = this.shapes.length - 1;
      }
      this.afterChange();
      return;
    }
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

  onPointerLeave() {
    this.hover = null;
    this.drawLayer();
  }

  onPointerCancel() {
    const d = this.drag;
    this.drag = null;
    this.draft = null;
    this.stroke = null;
    if (d?.start && this.selected >= 0) {
      this.shapes = this.shapes.map((s, i) => (i === this.selected ? d.start! : s));
    }
    this.afterChange();
  }

  /** Focusing a shape with the keyboard selects it. */
  selectShape(i: number) {
    if (this.tool !== 'select') this.tool = 'select';
    this.selected = i;
    this.drawLayer();
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
    if (!this.observer && this.stage && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.drawLayer());
      this.observer.observe(this.stage.nativeElement);
    }
    this.schedulePreview();
    this.drawLayer();
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
      if (s.type === 'brush') { this.previewBrush(ctx, img, s, W, H); continue; }
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

  /** A stroke in the preview: the picture under it pixelated in blocks of a third of the brush diameter (as the server does), cut to the stroke. */
  private previewBrush(ctx: CanvasRenderingContext2D, img: HTMLImageElement, s: Shape, W: number, H: number) {
    const pts = s.pts ?? [];
    if (!pts.length) return;
    const rad = Math.max(1, (s.r ?? 0) * W);
    const x1 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0] * W)) - rad - 2)), y1 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1] * H)) - rad - 2));
    const x2 = Math.min(W, Math.ceil(Math.max(...pts.map(p => p[0] * W)) + rad + 2)), y2 = Math.min(H, Math.ceil(Math.max(...pts.map(p => p[1] * H)) + rad + 2));
    const bw = x2 - x1, bh = y2 - y1;
    if (bw < 2 || bh < 2) return;
    const block = Math.max(4, Math.round((2 * rad) / 3));
    const tiny = document.createElement('canvas');
    tiny.width = Math.max(1, Math.floor(bw / block));
    tiny.height = Math.max(1, Math.floor(bh / block));
    const tctx = tiny.getContext('2d');
    const piece = document.createElement('canvas');
    piece.width = bw;
    piece.height = bh;
    const pctx = piece.getContext('2d');
    if (!tctx || !pctx) return;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(img, (x1 / W) * img.naturalWidth, (y1 / H) * img.naturalHeight, (bw / W) * img.naturalWidth, (bh / H) * img.naturalHeight, 0, 0, tiny.width, tiny.height);
    pctx.imageSmoothingEnabled = true;
    pctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, 0, 0, bw, bh);
    pctx.globalCompositeOperation = 'destination-in';   // keep only what the brush covers
    pctx.lineCap = 'round';
    pctx.lineJoin = 'round';
    pctx.lineWidth = 2 * rad;
    pctx.strokeStyle = '#000';
    pctx.beginPath();
    pctx.moveTo(pts[0][0] * W - x1, pts[0][1] * H - y1);
    if (pts.length === 1) pctx.lineTo(pts[0][0] * W - x1 + 0.01, pts[0][1] * H - y1);
    for (const p of pts.slice(1)) pctx.lineTo(p[0] * W - x1, p[1] * H - y1);
    pctx.stroke();
    ctx.drawImage(piece, x1, y1);
  }

  // ---- the layer that shows the brush strokes (and the ring of the brush) ----

  /** Draws every stroke as a translucent thick line with a ring, the selected one in blue, the one being painted, and the ring that shows the size. */
  drawLayer() {
    const c = this.layer?.nativeElement, st = this.stage?.nativeElement;
    if (!c || !st) return;
    const W = Math.round(st.clientWidth), H = Math.round(st.clientHeight);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const path = (g: CanvasRenderingContext2D, pts: [number, number][]) => {
      g.beginPath();
      g.moveTo(pts[0][0] * W, pts[0][1] * H);
      if (pts.length === 1) g.lineTo(pts[0][0] * W + 0.01, pts[0][1] * H);
      for (const p of pts.slice(1)) g.lineTo(p[0] * W, p[1] * H);
    };
    const paint = (pts: [number, number][], r: number, fill: string, edge: string) => {
      if (!pts.length) return;
      const ring = document.createElement('canvas');   // the edge: a stroke a little wider, with the inside cut out
      ring.width = W;
      ring.height = H;
      const g = ring.getContext('2d');
      if (!g) return;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = edge;
      g.lineWidth = 2 * r * W + 3;
      path(g, pts);
      g.stroke();
      g.globalCompositeOperation = 'destination-out';
      g.lineWidth = 2 * r * W;
      g.strokeStyle = '#000';
      path(g, pts);
      g.stroke();
      ctx.drawImage(ring, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = fill;
      ctx.lineWidth = 2 * r * W;
      path(ctx, pts);
      ctx.stroke();
    };
    this.shapes.forEach((s, i) => {
      if (s.type !== 'brush' || !s.pts?.length) return;
      const sel = i === this.selected;
      paint(s.pts, s.r ?? 0, sel ? 'rgba(51,102,255,0.30)' : 'rgba(255,61,113,0.30)', sel ? '#3366ff' : '#ff3d71');
    });
    if (this.stroke) paint(this.stroke, this.brushSize, 'rgba(255,61,113,0.30)', '#ff3d71');
    if (this.tool === 'brush' && this.hover && !this.stroke) {
      ctx.beginPath();
      ctx.arc(this.hover.x * W, this.hover.y * H, this.brushSize * W, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
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
