import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NbButtonModule, NbCardModule, NbDialogRef, NbInputModule, NbToastrService } from '@nebular/theme';
import { ContactForm, ContactService } from '../../../services/contact.service';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-contact',
  imports: [NbCardModule, NbButtonModule, NbInputModule, FormsModule],
  templateUrl: './contact.component.html',
  styleUrl: './contact.component.scss'
})
export class ContactComponent {
  form: ContactForm = { name: '', email: '', phone: '', subject: '', message: '', website: '', elapsedMs: 0 };
  sending = false;
  private readonly openedAt = Date.now();

  loggedIn = false;

  constructor(
    public dialogRef: NbDialogRef<ContactComponent>,
    private contactService: ContactService,
    private toastrService: NbToastrService,
    private auth: AuthService,
  ) {
    // the reply comes back to the sender's personal area, so only logged-in people can send
    this.auth.loadUserInfo().then(u => this.loggedIn = !!u).catch(() => this.loggedIn = false);
  }

  get valid(): boolean {
    const f = this.form;
    return this.loggedIn && f.message.trim().length >= 5 && (f.email.trim().length > 0 || f.phone.trim().length > 0);
  }

  async send() {
    if (!this.valid || this.sending) return;
    this.sending = true;
    try {
      await this.contactService.send({ ...this.form, elapsedMs: Date.now() - this.openedAt });
      this.toastrService.success('', 'הפנייה נשלחה, תודה!');
      this.dialogRef.close();
    } catch (err: any) {
      const msg = err?.status === 429 ? 'נשלחו יותר מדי פניות, נסו שוב מאוחר יותר'
        : err?.status === 400 ? 'יש לבדוק את הפרטים בטופס'
        : 'שגיאה בשליחת הפנייה';
      this.toastrService.danger('', msg);
    } finally {
      this.sending = false;
    }
  }
}
