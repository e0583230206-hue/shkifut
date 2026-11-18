import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NbButtonModule, NbCardModule, NbDialogRef, NbInputModule, NbToastrService } from '@nebular/theme';
import { AdminService } from '../../services/admin.service';

// The owner writes a general message: every user who logs in sees it in "הודעות מהערוץ" and gets a counter.
@Component({
  selector: 'app-broadcast-dialog',
  imports: [NbCardModule, NbButtonModule, NbInputModule, FormsModule],
  templateUrl: './broadcast-dialog.component.html',
})
export class BroadcastDialogComponent {
  title = '';
  text = '';
  sending = false;

  constructor(
    public dialogRef: NbDialogRef<BroadcastDialogComponent>,
    private adminService: AdminService,
    private toastrService: NbToastrService,
  ) { }

  get valid(): boolean {
    return this.title.trim().length >= 1 && this.title.trim().length <= 100
      && this.text.trim().length >= 1 && this.text.trim().length <= 2000;
  }

  async send() {
    if (!this.valid || this.sending) return;
    this.sending = true;
    try {
      await this.adminService.sendBroadcast(this.title.trim(), this.text.trim());
      this.toastrService.success('', 'ההודעה נשלחה לכל המשתמשים');
      this.dialogRef.close(true);
    } catch {
      this.toastrService.danger('', 'שגיאה בשליחת ההודעה');
    } finally {
      this.sending = false;
    }
  }
}
