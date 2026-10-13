import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NbButtonModule, NbCardModule, NbDialogRef, NbToastrService } from '@nebular/theme';

interface ReviewFigure {
  key: string;
  cropUrl: string;
  decision: string;
  visible: boolean;
  override: 'man' | 'blur' | null;
  faceMale: number | null;
  bodyMale: number | null;
  priority?: boolean;
  start?: number;
  end?: number;
}

const DECISIONS: Record<string, string> = {
  man: 'גבר', likely_man: 'כנראה גבר', woman: 'אישה', uncertain_gender: 'לא ודאי', person_without_clear_face: 'בלי פנים ברורות',
  manual_blur: 'טושטש ידנית',
};

/**
 * Quick review of the figures the moderation found in one file: confirm or correct each one
 * ("גבר" = show, "טשטש" = hide). Saving re-processes the file and keeps the corrections as training data.
 */
@Component({
  selector: 'app-figure-review',
  imports: [NbCardModule, NbButtonModule],
  templateUrl: './figure-review.component.html',
  styleUrl: './figure-review.component.scss'
})
export class FigureReviewComponent implements OnInit {
  fileId = '';
  figures: ReviewFigure[] = [];
  total = 0;
  loading = true;
  saving = false;
  /** STRICT_UNTIL_REVIEWED: the file is not shown normally to readers until a moderator saves, even without changes. */
  reviewed = true;
  strictMode = false;
  /** A bulk approval waiting for the moderator's explicit confirmation (inline panel, no browser dialog). */
  pendingBulk: { kind: 'all' | 'likely'; keys: string[] } | null = null;
  /** pending choices: key -> 'man' | 'blur' | '' (remove correction) */
  choices: Record<string, 'man' | 'blur' | ''> = {};

  constructor(
    public dialogRef: NbDialogRef<FigureReviewComponent>,
    private http: HttpClient,
    private toastr: NbToastrService,
  ) { }

  async ngOnInit() {
    try {
      const res = await firstValueFrom(this.http.get<{ figures: ReviewFigure[]; total: number; reviewed?: boolean; strictMode?: boolean }>(`/api/admin/files/${this.fileId}/figures`));
      this.figures = res.figures || [];
      this.total = res.total || 0;
      this.reviewed = res.reviewed !== false;
      this.strictMode = !!res.strictMode;
    } catch {
      this.toastr.danger('', 'שגיאה בטעינת הדמויות');
    } finally {
      this.loading = false;
    }
  }

  label(f: ReviewFigure) {
    return DECISIONS[f.decision] ?? f.decision;
  }

  /** What the figure will be after saving: the pending choice, else the current correction / decision. */
  effective(f: ReviewFigure): 'man' | 'blur' | 'model' {
    const c = this.choices[f.key];
    if (c === 'man' || c === 'blur') return c;
    if (c === '') return 'model';  // correction removed: the model decides again on re-processing
    return f.visible ? 'man' : 'blur';
  }

  choose(f: ReviewFigure, value: 'man' | 'blur') {
    // Choosing what the model already decided (without a correction) is just a confirmation.
    this.choices[f.key] = value;
  }

  clear(f: ReviewFigure) {
    this.choices[f.key] = '';
  }

  /** Blurred figures waiting for the moderator that look like men (shown first). */
  get likelyMen() {
    return this.figures.filter(f => f.decision === 'likely_man' && !f.override);
  }

  /** Figures that are blurred now and not explicitly marked "blur" by a moderator. */
  private get blurredNotPinned() {
    return this.figures.filter(f => this.effective(f) === 'blur' && f.override !== 'blur' && this.choices[f.key] !== 'blur');
  }

  get blurredCount() {
    return this.blurredNotPinned.length;
  }

  /** "Approve all men in the file": asks for confirmation first; the choices are saved with the main button. */
  approveAllMen() {
    const keys = this.blurredNotPinned.map(f => f.key);
    if (keys.length) this.pendingBulk = { kind: 'all', keys };
  }

  /** Same, only for the "likely man" queue. */
  approveLikelyMen() {
    const keys = this.likelyMen.filter(f => this.effective(f) === 'blur').map(f => f.key);
    if (keys.length) this.pendingBulk = { kind: 'likely', keys };
  }

  confirmBulk() {
    if (!this.pendingBulk) return;
    for (const key of this.pendingBulk.keys) this.choices[key] = 'man';
    this.pendingBulk = null;
  }

  cancelBulk() {
    this.pendingBulk = null;
  }

  get changes() {
    return Object.keys(this.choices).length;
  }

  /** Saving is possible with changes, or (strict mode) just to confirm that the figures were reviewed. */
  get canSave() {
    return this.changes > 0 || (this.strictMode && !this.reviewed);
  }

  async save() {
    if (!this.canSave || this.saving) return;
    this.saving = true;
    try {
      await firstValueFrom(this.http.post(`/api/admin/files/${this.fileId}/figures`, { overrides: this.choices }));
      this.toastr.success('', this.changes ? 'התיקונים נשמרו, הקובץ מעובד מחדש' : 'הבדיקה נשמרה');
      this.dialogRef.close(true);
    } catch {
      this.toastr.danger('', 'שמירת התיקונים נכשלה');
    } finally {
      this.saving = false;
    }
  }

  time(s?: number) {
    if (s === undefined) return '';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
}
