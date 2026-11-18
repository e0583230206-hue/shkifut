import { Component, Input, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NbButtonModule, NbCardModule, NbInputModule, NbToastrService } from '@nebular/theme';
import { AdminService } from '../../../services/admin.service';
import { Reports, Report } from '../../../models/report.model';
import { ThreadMessage } from '../../../services/my-messages.service';
import { MessageTimePipe } from '../../../pipes/message-time.pipe';

type AdminThreadMessage = ThreadMessage & { by?: string };

@Component({
  selector: 'app-reports',
  imports: [NbCardModule, NbButtonModule, NbInputModule, FormsModule, MessageTimePipe],
  templateUrl: './reports.component.html',
  styleUrl: './reports.component.scss'
})
export class ReportsComponent implements OnInit {
  reports: Reports = [];
  @Input() status: 'open' | 'closed' | 'all' = 'open';

  threads: Record<number, AdminThreadMessage[] | undefined> = {};
  expanded: Record<number, boolean> = {};
  drafts: Record<number, string> = {};

  constructor(
    private adminService: AdminService,
    private toastrService: NbToastrService
  ) { }

  ngOnInit(): void {
    this.adminService.getReports(this.status).then(reports => {
      this.reports = reports;
    })
      .catch(() => this.toastrService.danger('', 'אירעה שגיאה בעת טעינת הדיווחים'));
  }

  toggleReport(report: Report) {
    report.closed = !report.closed;
    report.updatedAt = new Date();
    this.adminService.setReports(report).then(() => {
      this.toastrService.success('', report.closed ? 'דיווח נסגר בהצלחה' : 'דיווח נפתח מחדש');
      this.adminService.refreshInbox();
      this.status === 'all' ? this.reports[this.reports.findIndex(r => r.id === report.id)] = report : this.reports = this.reports.filter(r => r.id !== report.id);
    }).catch(() => this.toastrService.danger('', ''));
  }

  async toggleThread(report: Report) {
    this.expanded[report.id] = !this.expanded[report.id];
    if (this.expanded[report.id] && !this.threads[report.id]) {
      try {
        const res = await this.adminService.getThread('report', report.id);
        this.threads[report.id] = res.thread;
      } catch {
        this.toastrService.danger('', 'שגיאה בטעינת השיחה');
      }
    }
  }

  // the reply goes to the reporter's personal area (reporters are always logged in)
  async sendReply(report: Report) {
    const reply = (this.drafts[report.id] || '').trim();
    if (!reply) return;
    try {
      await this.adminService.setReportReply(report.id, reply);
      this.drafts[report.id] = '';
      this.threads[report.id] = [...(this.threads[report.id] || []), { from: 'admin', text: reply, at: new Date().toISOString() }];
      report.reply = reply;
      report.repliedAt = new Date().toISOString();
      this.toastrService.success('', 'התשובה נשמרה ותופיע אצל המדווח');
    } catch {
      this.toastrService.danger('', 'שגיאה בשמירת התשובה');
    }
  }

  viewReport(messageId: number) {
    window.open(`${window.location.origin}/#${messageId}`, '_blank');
  }
}
