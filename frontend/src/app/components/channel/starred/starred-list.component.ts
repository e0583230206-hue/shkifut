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
        <p class="empty">עדיין אין הודעות שמורות. כדי לשמור הודעה, לחצו על הכוכב שמעליה.<br>ההודעות השמורות נשמרות בדפדפן הזה בלבד.</p>
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
    .starred-card { width: min(640px, 94vw); max-height: 80vh; margin: 0; }
    .starred-body { overflow-y: auto; }
    .star-on { color: #f5a300; }
    .empty { color: var(--tc-muted, #5b6785); text-align: center; padding: 18px 8px; line-height: 1.7; }
    .starred-row { display: flex; align-items: stretch; border-bottom: 1px solid var(--tc-border, #eceff6); }
    .starred-item {
      flex: 1; display: block; min-width: 0; padding: 0.6rem 0.25rem; text-align: right;
      background: none; border: 0; color: inherit; cursor: pointer;
    }
    .starred-item:hover, .starred-item:focus-visible { background: var(--tc-surface-2, #f4f6fa); }
    .starred-remove {
      flex: none; width: 40px; display: grid; place-items: center; background: none; border: 0; cursor: pointer;
      color: #f5a300; font-size: 1.2rem;
    }
    .starred-remove:hover { background: var(--tc-surface-2, #f4f6fa); }
  `],
})
export class StarredListComponent {
  constructor(public dialogRef: NbDialogRef<StarredListComponent>, public starred: StarredService, private chatService: ChatService) {}

  open(s: StarredMessage) {
    this.chatService.jumpToMessage(s.id);
    this.dialogRef.close();
  }
}
