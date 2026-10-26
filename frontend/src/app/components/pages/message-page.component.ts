import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ChatMessage, ChatService } from '../../services/chat.service';
import { NbLayoutModule } from '@nebular/theme';
import { MessageComponent } from '../channel/chat/message/message.component';

/**
 * /m/<id>: the shareable address of one message (the server adds the title, description and canonical address).
 * The page shows the message itself and a button that opens it in the channel. It does NOT move on to the channel by itself:
 * a search engine runs the page, and a page that jumps to the home page is treated as a redirect and left out of the index.
 */
@Component({
  selector: 'app-message-page',
  imports: [MessageComponent, RouterLink, NbLayoutModule],
  template: `
    <nb-layout>
    <nb-layout-column>
    <main class="message-page" dir="rtl">
      <a class="site-name" routerLink="/">{{ siteName }}</a>
      @switch (state) {
        @case ('loading') { <p class="note">טוען את ההודעה...</p> }
        @case ('ok') {
          <app-message [message]="message"></app-message>
          <p class="open"><a class="open-link" routerLink="/" [fragment]="id">פתח בערוץ</a></p>
        }
        @default {
          <h1>ההודעה לא נמצאה</h1>
          <p class="note">ייתכן שההודעה נמחקה.</p>
          <p class="open"><a class="open-link" routerLink="/">לערוץ</a></p>
        }
      }
    </main>
    </nb-layout-column>
    </nb-layout>
  `,
  styles: [`
    .message-page { max-width: 720px; margin: 0 auto; padding: 16px; }
    .site-name { display: inline-block; font-weight: 700; font-size: 1.4rem; margin-bottom: 12px; color: inherit; text-decoration: none; }
    .note { color: var(--tc-muted, #5b6485); }
    .open { margin: 16px 0; }
    .open-link { display: inline-block; padding: 8px 18px; border-radius: 999px; background: #2f4bff; color: #fff; text-decoration: none; font-weight: 600; }
    h1 { font-size: 1.3rem; }
  `],
})
export class MessagePageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private chat = inject(ChatService);

  id = '';
  state: 'loading' | 'ok' | 'gone' = 'loading';
  message?: ChatMessage;

  get siteName(): string {
    return this.chat.channelInfo?.name || 'שקיפות';
  }

  async ngOnInit() {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    this.chat.updateChannelInfo().catch(() => undefined); // the channel name for the header and the message
    if (!/^\d{1,12}$/.test(this.id)) {
      this.state = 'gone';
      return;
    }
    try {
      this.message = await this.chat.getMessage(this.id);
      this.state = 'ok';
    } catch {
      this.state = 'gone';
    }
  }
}
