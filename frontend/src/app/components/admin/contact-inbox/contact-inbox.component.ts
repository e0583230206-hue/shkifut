import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NbButtonModule, NbCardModule, NbInputModule, NbToastrService } from '@nebular/theme';
import { ContactMessage, ContactService } from '../../../services/contact.service';
import { MessageTimePipe } from '../../../pipes/message-time.pipe';
import { AdminService } from '../../../services/admin.service';
import { ThreadMessage } from '../../../services/my-messages.service';

type AdminThreadMessage = ThreadMessage & { by?: string };

@Component({
  selector: 'app-contact-inbox',
  imports: [NbCardModule, NbButtonModule, NbInputModule, MessageTimePipe, FormsModule],
  templateUrl: './contact-inbox.component.html',
})
export class ContactInboxComponent implements OnInit {
  messages: ContactMessage[] = [];
  status: 'open' | 'all' = 'open';
  loading = false;

  /** the conversation of an open message (loaded when it is opened) */
  threads: Record<number, AdminThreadMessage[] | undefined> = {};
  expanded: Record<number, boolean> = {};
  drafts: Record<number, string> = {};

  constructor(private contactService: ContactService, private toastrService: NbToastrService, private adminService: AdminService) { }

  ngOnInit(): void {
    this.load();
  }

  async load(status: 'open' | 'all' = this.status) {
    this.status = status;
    this.loading = true;
    try {
      this.messages = await this.contactService.list(status);
    } catch {
      this.toastrService.danger('', 'שגיאה בטעינת הפניות');
    } finally {
      this.loading = false;
    }
  }

  async toggleThread(m: ContactMessage) {
    this.expanded[m.id] = !this.expanded[m.id];
    if (this.expanded[m.id] && !this.threads[m.id]) {
      await this.reloadThread(m);
    }
  }

  async reloadThread(m: ContactMessage) {
    try {
      const res = await this.adminService.getThread('contact', m.id);
      this.threads[m.id] = res.thread;
    } catch {
      this.toastrService.danger('', 'שגיאה בטעינת השיחה');
    }
  }

  // the reply goes to the sender's personal area (only if he is logged in: the form requires it)
  async sendReply(m: ContactMessage) {
    const reply = (this.drafts[m.id] || '').trim();
    if (!reply) return;
    try {
      await this.contactService.setReply(m.id, reply);
      this.drafts[m.id] = '';
      this.threads[m.id] = [...(this.threads[m.id] || []), { from: 'admin', text: reply, at: new Date().toISOString() }];
      m.reply = reply;
      m.repliedAt = new Date().toISOString();
      this.toastrService.success('', 'התשובה נשמרה ותופיע אצל הפונה');
    } catch {
      this.toastrService.danger('', 'שגיאה בשמירת התשובה');
    }
  }

  async toggle(m: ContactMessage) {
    try {
      await this.contactService.setHandled(m.id, !m.handled);
      m.handled = !m.handled;
      this.adminService.refreshInbox();
      if (this.status === 'open' && m.handled) {
        this.messages = this.messages.filter(x => x.id !== m.id);
      }
    } catch {
      this.toastrService.danger('', 'שגיאה בעדכון הפנייה');
    }
  }
}
