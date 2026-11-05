import { Component } from '@angular/core';
import { NbButtonModule, NbCardModule, NbDialogRef, NbIconModule } from '@nebular/theme';
import { ChatService } from '../../../services/chat.service';
import { StarredMessage, StarredService } from '../../../services/starred.service';
import { MessageTimePipe } from '../../../pipes/message-time.pipe';

/** The saved messages (the ones with a star), in a window: choosing one jumps to it in the chat, the star can be taken away from the list. */
@Component({
  selector: 'app-starred-list',
  imports: [NbCardModule, NbButtonModule, NbIconModule, MessageTimePipe],
  template: `
    <nb-card class="starred-card" role="dialog" aria-label="הודעות שמורות">
      <nb-card-header class="d-flex align-items-center gap-2">
        <nb-icon icon="star" class="star-on"></nb-icon>
        <span class="flex-grow-1 fw-bold">הודעות שמורות</span>
        @if (starred.count) {
        <button nbButton ghost size="small" status="danger" (click)="starred.clear()" title="הסרת כל הכוכבים">נקה הכל</button>
        }
        <button nbButton ghost shape="round" size="small" title="סגור" aria-label="סגור" (click)="dialogRef.close()">
          <nb-icon icon="close"></nb-icon>
        </button>
      </nb-card-header>
      <nb-card-body class="starred-body">
        @if (!starred.count) {
        <div class="empty">
          <span class="empty-star"><nb-icon icon="star-outline"></nb-icon></span>
          <strong>עדיין אין הודעות שמורות</strong>
          <p>כדי לשמור הודעה, לחצו על הכוכב שמעליה.<br>ההודעות השמורות נשמרות בדפדפן הזה בלבד.</p>
        </div>
        }
        <ul class="list-unstyled m-0">
          @for (s of starred.items; track s.id) {
          <li class="starred-row">
            <button type="button" class="starred-item" (click)="open(s)">
              @if (s.time) { <small class="text-muted d-block">{{ s.time | messageTime }}</small> }
              <span>{{ s.snippet }}</span>
            </button>
            <button type="button" class="starred-remove" (click)="starred.remove(s.id)" title="הסר מהשמורים" aria-label="הסר מהשמורים">
              <nb-icon icon="star"></nb-icon>
            </button>
          </li>
          }
        </ul>
      </nb-card-body>
    </nb-card>
  `,
  styles: [`
    .starred-card { width: min(640px, 94vw); max-height: 80vh; margin: 0; overflow: hidden; border-top: 4px solid #f5a300; }
    .starred-body { overflow-y: auto; }
    .star-on { color: #f5a300; font-size: 1.5rem; filter: drop-shadow(0 0 5px rgba(245, 163, 0, 0.6)); }

    .empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 26px 12px 20px; text-align: center; color: var(--tc-muted, #5b6785); }
    .empty strong { color: var(--tc-text, #1b2140); font-size: 1.1rem; }
    .empty p { margin: 0; line-height: 1.7; }
    .empty-star {
      display: grid; place-items: center; width: 84px; height: 84px; margin-bottom: 8px; border-radius: 50%;
      color: #f5a300; font-size: 2.6rem;
      background: radial-gradient(circle, rgba(245, 163, 0, 0.22), rgba(245, 163, 0, 0.06) 65%, transparent 70%);
      animation: starred-float 3s ease-in-out infinite;
    }
    .empty-star nb-icon { filter: drop-shadow(0 0 8px rgba(245, 163, 0, 0.5)); }

    .starred-row {
      display: flex; align-items: stretch; margin: 6px 0; border: 1px solid var(--tc-border, #eceff6); border-inline-start: 4px solid #f5a300;
      border-radius: 12px; background: var(--tc-surface, #fff); overflow: hidden;
      transition: box-shadow 0.18s ease, transform 0.18s ease;
    }
    .starred-row:hover { box-shadow: 0 6px 16px rgba(245, 163, 0, 0.22); transform: translateY(-1px); }
    .starred-item {
      flex: 1; display: block; min-width: 0; padding: 0.65rem 0.8rem; text-align: right;
      background: none; border: 0; color: inherit; cursor: pointer;
    }
    .starred-item:hover, .starred-item:focus-visible { background: rgba(245, 163, 0, 0.08); }
    .starred-remove {
      flex: none; width: 44px; display: grid; place-items: center; background: none; border: 0; cursor: pointer;
      color: #f5a300; font-size: 1.3rem; transition: transform 0.15s ease, background-color 0.15s ease;
    }
    .starred-remove:hover { background: rgba(245, 163, 0, 0.14); transform: scale(1.15); }

    @keyframes starred-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
    @media (prefers-reduced-motion: reduce) { .empty-star { animation: none; } .starred-row { transition: none; } }
  `],
})
export class StarredListComponent {
  constructor(public dialogRef: NbDialogRef<StarredListComponent>, public starred: StarredService, private chatService: ChatService) {}

  open(s: StarredMessage) {
    this.chatService.jumpToMessage(s.id);
    this.dialogRef.close();
  }
}
