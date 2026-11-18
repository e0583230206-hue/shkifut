import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NbButtonModule, NbCardModule, NbInputModule, NbToastrService } from '@nebular/theme';
import { MessageTimePipe } from '../../pipes/message-time.pipe';
import { AuthService } from '../../services/auth.service';
import { Broadcast, MyItem, MyMessagesService } from '../../services/my-messages.service';

type Tab = 'news' | 'mine';

// The user's personal area: general messages from the channel, and his own reports and messages with their conversations.
@Component({
  selector: 'app-my-messages',
  imports: [NbCardModule, NbButtonModule, NbInputModule, FormsModule, MessageTimePipe],
  templateUrl: './my-messages.component.html',
  styleUrl: './my-messages.component.scss',
})
export class MyMessagesComponent implements OnInit {
  tab: Tab = 'news';
  loading = true;
  error = false;
  name = '';

  broadcasts: Broadcast[] = [];
  /** how many of the newest general messages were new to him when the page opened */
  newNews = 0;

  items: MyItem[] = [];
  selected?: MyItem;
  reply = '';
  sending = false;

  constructor(
    private myMessages: MyMessagesService,
    private auth: AuthService,
    private router: Router,
    private toastrService: NbToastrService,
  ) { }

  async ngOnInit() {
    this.auth.loadUserInfo().then(u => this.name = u?.username || '').catch(() => undefined);
    try {
      const [summary, news, mine] = await Promise.all([
        this.myMessages.summary(),
        this.myMessages.broadcasts(),
        this.myMessages.list(),
      ]);
      this.broadcasts = news;
      this.newNews = summary.broadcasts;
      this.items = mine;
      if (news.length) {
        // everything shown is now read: the counter goes down
        this.myMessages.markBroadcastsSeen(news[0].id).catch(() => undefined);
      }
      if (!news.length && mine.length) this.tab = 'mine';
    } catch {
      this.error = true;
    } finally {
      this.loading = false;
    }
  }

  get newMineCount(): number {
    return this.items.reduce((n, i) => n + i.unread, 0);
  }

  isNew(index: number): boolean {
    return index < this.newNews;
  }

  statusLabel(i: MyItem): string {
    if (i.status === 'handled') return 'טופל';
    if (i.status === 'closed') return 'נסגר';
    return 'פתוח';
  }

  async open(i: MyItem) {
    this.selected = i;
    this.reply = '';
    if (i.unread > 0) {
      i.unread = 0;
      this.myMessages.markSeen(i.kind, i.id).catch(() => undefined);
    }
  }

  back() {
    this.selected = undefined;
  }

  async send(i: MyItem) {
    const text = this.reply.trim();
    if (!text || this.sending) return;
    this.sending = true;
    try {
      await this.myMessages.reply(i.kind, i.id, text);
      i.thread = [...i.thread, { from: 'user', text, at: new Date().toISOString() }];
      if (i.status !== 'open') i.status = 'open';
      this.reply = '';
    } catch {
      this.toastrService.danger('', 'שגיאה בשליחת ההודעה, נסו שוב');
    } finally {
      this.sending = false;
    }
  }

  home() {
    this.router.navigateByUrl('/');
  }
}
