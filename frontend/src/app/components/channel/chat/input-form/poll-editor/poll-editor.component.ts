import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NbButtonModule, NbCardModule, NbDialogRef, NbIconModule, NbInputModule } from '@nebular/theme';
import { Poll } from '../../../../../services/chat.service';

/** Poll editor for writers: question, 2-10 options, single or multiple choice. Closes with the poll. */
@Component({
  selector: 'app-poll-editor',
  imports: [NbCardModule, NbButtonModule, NbIconModule, NbInputModule, FormsModule],
  template: `
<nb-card class="poll-editor" role="dialog" aria-label="יצירת סקר">
  <nb-card-header>סקר חדש</nb-card-header>
  <nb-card-body>
    <label for="poll-question" class="d-block mb-1">שאלה</label>
    <input nbInput fullWidth id="poll-question" maxlength="200" [(ngModel)]="question" placeholder="מה השאלה?">
    <div class="mt-3 mb-1">תשובות</div>
    @for (o of options; track $index; let i = $index) {
    <div class="d-flex gap-2 mb-2">
      <input nbInput fullWidth class="poll-option-input" maxlength="100" [(ngModel)]="options[i]"
        [placeholder]="'תשובה ' + (i + 1)" [attr.aria-label]="'תשובה ' + (i + 1)">
      @if (options.length > 2) {
      <button nbButton ghost size="small" status="danger" (click)="options.splice(i, 1)" title="הסר" aria-label="הסר תשובה">
        <nb-icon icon="close"></nb-icon>
      </button>
      }
    </div>
    }
    @if (options.length < 10) {
    <button nbButton size="small" ghost status="primary" class="add-option" (click)="options.push('')">
      <nb-icon icon="plus"></nb-icon> הוסף תשובה
    </button>
    }
    <div class="form-check mt-3">
      <input class="form-check-input" type="checkbox" id="poll-multiple" [(ngModel)]="multiple">
      <label class="form-check-label" for="poll-multiple">אפשר לבחור כמה תשובות</label>
    </div>
    @if (error) {
    <div class="text-danger small mt-2">{{ error }}</div>
    }
  </nb-card-body>
  <nb-card-footer class="d-flex gap-2">
    <button nbButton status="primary" class="poll-done" (click)="done()">הוסף להודעה</button>
    <button nbButton ghost (click)="dialogRef.close()">ביטול</button>
  </nb-card-footer>
</nb-card>`,
  styles: [`.poll-editor { width: min(520px, 94vw); }`]
})
export class PollEditorComponent {
  question = '';
  options: string[] = ['', ''];
  multiple = false;
  error = '';

  constructor(public dialogRef: NbDialogRef<PollEditorComponent>) { }

  done() {
    const question = this.question.trim();
    const options = this.options.map(o => o.trim()).filter(Boolean);
    if (!question) { this.error = 'צריך שאלה'; return; }
    if (options.length < 2) { this.error = 'צריך לפחות 2 תשובות'; return; }
    if (new Set(options.map(o => o.toLowerCase())).size !== options.length) { this.error = 'יש תשובות כפולות'; return; }
    const poll: Poll = { question, options: options.map(text => ({ text, count: 0 })), multiple: this.multiple };
    this.dialogRef.close(poll);
  }
}
