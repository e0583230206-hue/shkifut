import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { NbButtonModule, NbCardModule } from '@nebular/theme';
import { MessageTimePipe } from '../../pipes/message-time.pipe';
import { MyMessage, MyMessagesService } from '../../services/my-messages.service';

@Component({
  selector: 'app-my-messages',
  imports: [NbCardModule, NbButtonModule, MessageTimePipe],
  templateUrl: './my-messages.component.html',
})
export class MyMessagesComponent implements OnInit {
  items: MyMessage[] = [];
  loading = true;
  error = false;

  constructor(private myMessages: MyMessagesService, private router: Router) { }

  async ngOnInit() {
    try {
      this.items = await this.myMessages.list();
    } catch {
      this.error = true;
    } finally {
      this.loading = false;
    }
  }

  // opening a reply marks it as read (the count in the header goes down)
  async open(m: MyMessage) {
    if (!m.unread) return;
    m.unread = false;
    try { await this.myMessages.markSeen(m.kind, m.id); } catch { /* it stays unread on the next visit */ }
  }

  back() {
    this.router.navigateByUrl('/');
  }
}
