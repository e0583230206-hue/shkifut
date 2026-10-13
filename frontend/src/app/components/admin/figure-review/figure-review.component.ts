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
  /** pending choices: key -> 'man' | 'blur' | '' (remove correction) */
  choices: Record<string, 'man' | 'blur' | ''> = {};

  constructor(
    public dialogRef: NbDialogRef<FigureReviewComponent>,
    private http: HttpClient,
    private toastr: NbToastrService,
  ) { }

  async ngOnInit() {
    try {
      const res = await firstValueFrom(this.http.get<{ figures: ReviewFigure[]; total: number }>(`/api/admin/files/${this.fileId}/figures`));
      this.figures = res.figures || [];
      this.total = res.total || 0;
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

  /** "Approve all men in the file": every currently blurred figure in the grid becomes "man" (saved with the main button). */
  approveAllMen() {
    const targets = this.blurredNotPinned;
    if (!targets.length) return;
    if (!confirm(`לסמן ${targets.length} דמויות מטושטשות כגברים? הן יוצגו לקוראים ללא טשטוש אחרי השמירה. דמויות שסימנת "טשטש" לא ישתנו.`)) return;
    for (const f of targets) this.choices[f.key] = 'man';
  }

  /** Same, only for the "likely man" queue. */
  approveLikelyMen() {
    const targets = this.likelyMen.filter(f => this.effective(f) === 'blur');
    if (!targets.length) return;
    if (!confirm(`לאשר ${targets.length} דמויות "כנראה גבר" כגברים?`)) return;
    for (const f of targets) this.choices[f.key] = 'man';
  }

  get changes() {
    return Object.keys(this.choices).length;
  }

  async save() {
    if (!this.changes || this.saving) return;
    this.saving = true;
    try {
      await firstValueFrom(this.http.post(`/api/admin/files/${this.fileId}/figures`, { overrides: this.choices }));
      this.toastr.success('', 'התיקונים נשמרו, הקובץ מעובד מחדש');
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
