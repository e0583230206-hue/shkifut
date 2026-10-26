import { Component, OnInit } from '@angular/core';
import { NbButtonModule, NbCardModule, NbToastrService } from '@nebular/theme';
import { ContactMessage, ContactService } from '../../../services/contact.service';
import { MessageTimePipe } from '../../../pipes/message-time.pipe';
import { AdminService } from '../../../services/admin.service';

@Component({
  selector: 'app-contact-inbox',
  imports: [NbCardModule, NbButtonModule, MessageTimePipe],
  templateUrl: './contact-inbox.component.html',
})
export class ContactInboxComponent implements OnInit {
  messages: ContactMessage[] = [];
  status: 'open' | 'all' = 'open';
  loading = false;

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
