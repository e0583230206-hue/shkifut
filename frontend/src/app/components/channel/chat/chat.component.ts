
import { Component, OnInit, NgZone, OnDestroy, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  NbBadgeModule,
  NbButtonModule,
  NbCardModule,
  NbChatModule,
  NbIconModule,
  NbLayoutModule,
  NbListModule,
  NbToastrService
} from "@nebular/theme";
import { MessageComponent } from "./message/message.component";
import { firstValueFrom, interval, skip } from 'rxjs';
import { ChatMessage, ChatService } from '../../../services/chat.service';
import { AuthService } from '../../../services/auth.service';
import { ActivatedRoute } from '@angular/router';
import { NotificationsService } from '../../../services/notifications.service';
import { User } from '../../../models/user.model';
import { AdminService } from '../../../services/admin.service';
import { MediaModerationService } from '../../../services/media-moderation.service';
import { Ad, AdsService } from '../../../services/ads.service';
import { AdvertisingComponent } from '../advertising/advertising.component';
import { PinnedBarComponent } from './pinned-bar/pinned-bar.component';
import { TopicBarComponent } from './topic-bar/topic-bar.component';
import { WaitingBarComponent } from './waiting-bar/waiting-bar.component';
import { WaitingService } from '../../../services/waiting.service';
import { advanceMarker, firstUnreadByTime, isAfterMarker, newestVisibleByTime, readMarker, ReadMarker, TimedItem, unreadCountByTime, writeMarker } from '../../../read-position';

type LoadMsgOpt = {
  scrollDown?: boolean;
  messageId?: number;
  mark?: boolean;
  resetList?: boolean;
}

type ScrollOpt = {
  messageId: number;
  smooth?: boolean;
  mark?: boolean;
  block?: ScrollLogicalPosition;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    FormsModule,
    NbLayoutModule,
    NbChatModule,
    NbCardModule,
    NbIconModule,
    NbButtonModule,
    NbListModule,
    NbBadgeModule,
    MessageComponent,
    AdvertisingComponent,
    PinnedBarComponent,
    TopicBarComponent,
    WaitingBarComponent
  ],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss'
})
export class ChatComponent implements OnInit, OnDestroy {
  private eventSource!: EventSource;
  messages: ChatMessage[] = [];
  scheduledMessages!: ChatMessage[];
  hideScheduledMessages: boolean = false;
  userInfo?: User;
  isLoading: boolean = false;
  offset: number = 0;
  limit: number = 20;
  hasOldMessages: boolean = true;
  hasNewMessages: boolean = false;
  thereNewMessages: boolean = false;
  showScrollToBottom: boolean = false;
  private lastHeartbeat: number = Date.now();
  private subLastHeartbeat: any;
  /** Read position when the channel was opened (fixed for this visit: where the "unread" divider goes). */
  private openMarker: ReadMarker = { id: 0 };
  /** Newest message actually seen on screen, by time then id (persisted; see read-position.ts). */
  private storedMarker: ReadMarker = readMarker((k) => localStorage.getItem(k));

  /** A loaded message as the read position sees it: its id and its time in ms. */
  private timed(m: ChatMessage): TimedItem | undefined {
    if (m.id == null) return undefined;
    const at = m.timestamp ? new Date(m.timestamp).getTime() : NaN;
    return { id: m.id, at: Number.isNaN(at) ? undefined : at };
  }

  get firstUnreadId(): number | undefined {
    return firstUnreadByTime(this.messages.map(m => this.timed(m)).filter((t): t is TimedItem => !!t), this.openMarker);
  }

  get unreadCount(): number {
    return unreadCountByTime(this.messages.filter(m => !m.deleted).map(m => this.timed(m)).filter((t): t is TimedItem => !!t), this.storedMarker);
  }

  constructor(
    private chatService: ChatService,
    private _authService: AuthService,
    private _adminService: AdminService,
    private toastrService: NbToastrService,
    private notificationService: NotificationsService,
    private zone: NgZone,
    private router: ActivatedRoute,
    private mediaModeration: MediaModerationService,
    private adsService: AdsService,
    private waiting: WaitingService,
  ) {
    this._adminService.schedulingBusObservable.subscribe(() => {
      //this.scheduledMessages.length = 0;
      this.loadScheduledMessages();
    });
  }

  @HostListener('window:scroll', [])
  onWindowScroll() {
    this.onListScroll();
  }

  @HostListener('document:keydown', ['$event'])
  @HostListener('window:click', ['$event'])
  onUserAction(event: MouseEvent | KeyboardEvent) {
    this.removeMsgMarked();
    const target = event.target as HTMLElement;
    const quoteElement = target.closest('[quote-id]')
    if (quoteElement) {
      const quoteId = quoteElement.getAttribute('quote-id');
      this.scrollToId({ messageId: Number(quoteId), smooth: true, mark: true });
    }
  }

  scrollToId(opt: ScrollOpt) {
    const element = document.getElementById(opt.messageId.toString());
    if (element) {
      element.scrollIntoView({ behavior: opt.smooth ? 'smooth' : 'instant', block: opt.block ?? 'center' });
      this.removeMsgMarked();
      opt.mark && element.classList.add('mark_message');
    } else {
      this.loadMessages({ scrollDown: false, messageId: opt.messageId, mark: opt.mark });
    }
  }

  private removeMsgMarked() {
    document.querySelectorAll('.mark_message').forEach((el) => {
      el.classList.remove('mark_message');
    });
  }

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.router.fragment.subscribe(fragment => {
        if (fragment) {
          const messageId = Number(fragment);
          if (!Number.isInteger(messageId)) return;
          this.scrollToId({ messageId: messageId, mark: true });
        }
      });
    }, 800);
  }

  /** In-feed ads (every N messages), when enabled in the admin settings. */
  ad?: Ad;

  ngOnInit() {
    this.chatService.getEmojisList(true);
    this.adsService.getAds().then(ad => this.ad = ad.enabled ? ad : undefined).catch(() => this.ad = undefined);

    this.initializeMessageListener();
    this.keepAliveSSE();
    this.chatService.loadTopics();
    this.topicSub = this.chatService.selectedTopic$.pipe(skip(1)).subscribe(() => this.reloadForTopic());

    // After the current click finishes bubbling (the window click handler clears highlights).
    this.jumpSub = this.chatService.jump$.subscribe(id =>
      setTimeout(() => this.scrollToId({ messageId: id, smooth: true, mark: true }), 50));

    this._authService.loadUserInfo().then((res) => {
      this.userInfo = res;
      this.waiting.init(res);
      this.userInfo?.privileges?.['writer'] && this.loadScheduledMessages();
      this.notificationService.init();
    });

    // Open where the reader left off: at the first unread message (with a divider), or at the bottom.
    this.loadMessages().then(() => {
      // A marker saved before the time was stored: fill the time in now, from the message if it is loaded (no loss of place).
      if (this.storedMarker.id && this.storedMarker.at === undefined) {
        const loaded = this.messages.find(m => m.id === this.storedMarker.id);
        const t = loaded && this.timed(loaded);
        if (t && t.at !== undefined) {
          this.storedMarker = { id: t.id, at: t.at }; // same message: the id rule would not move it, so set it directly
          writeMarker((k, v) => localStorage.setItem(k, v), this.storedMarker);
        }
      }
      const marker = this.storedMarker;
      const timed = this.messages.map(m => this.timed(m)).filter((t): t is TimedItem => !!t);
      const hasUnread = !!marker.id && timed.some(t => isAfterMarker(t, marker));
      if (hasUnread) {
        this.openMarker = { ...marker };
        setTimeout(() => {
          const first = this.firstUnreadId;
          // not loaded yet (left off long ago): load around the last read message
          this.scrollToId({ messageId: first ?? marker.id, smooth: false, mark: false, block: first ? 'start' : 'center' });
          setTimeout(() => this.markVisibleAsRead(), 300);
        }, 200);
      } else {
        this.scrollToBottom(false);
        const newest = this.timed(this.messages[0] ?? {});
        if (!marker.id && newest) this.setReadTo(newest); // first visit: start from now
      }
    });
  }

  /** Moves the read position forward to `item` (never back). Persists the id and the time. */
  setReadTo(item: TimedItem) {
    const next = advanceMarker(this.storedMarker, item);
    if (next === this.storedMarker || (next.id === this.storedMarker.id && next.at === this.storedMarker.at)) return;
    this.storedMarker = next;
    writeMarker((k, v) => localStorage.setItem(k, v), next);
  }

  /** A message counts as read once it has been on screen. */
  markVisibleAsRead() {
    const headerBottom = document.querySelector('nb-layout-header')?.getBoundingClientRect().bottom ?? 0;
    const items = this.messages.map(m => {
      const r = document.getElementById(String(m.id))?.getBoundingClientRect();
      return { ...(this.timed(m) ?? { id: m.id!, at: undefined }), top: r?.top ?? -1, bottom: r?.bottom ?? -1 };
    });
    const seen = newestVisibleByTime(items, headerBottom, window.innerHeight);
    if (seen) this.setReadTo(seen);
  }

  private async initializeMessageListener() {
    this.eventSource = this.chatService.sseListener();
    this.eventSource.onmessage = (event) => {

      this.lastHeartbeat = Date.now();

      const message = JSON.parse(event.data);
      switch (message.type) {
        case 'new-message':
          if (this.hasNewMessages) break;
          if (this.chatService.selectedTopic && message.message.topic !== this.chatService.selectedTopic) break;
          this.zone.run(() => {
            // A held message (managers only) that was released arrives again as new: it moves to the top instead of showing twice.
            this.messages = this.messages.filter(m => m.id !== message.message.id);
            this.messages.unshift(message.message);
            this.thereNewMessages = !(message.message.author === this.userInfo?.username);
            setTimeout(() => this.markVisibleAsRead(), 300); // read only if it is actually on screen
            if (this.userInfo?.privileges?.['writer'] && this.scheduledMessages && message.message.author === "Scheduled") {
              this.loadScheduledMessages(true);
            }
          });
          break;
        case 'delete-message':
          if (this.userInfo?.privileges?.['writer']) {
            this.zone.run(() => {
              const index = this.messages.findIndex(m => m.id === message.message.id);
              if (index !== -1) {
                this.messages[index].deleted = true;
                this.messages[index].last_edit = message.message.last_edit;
              }
            });
            break;
          };
          this.zone.run(() => {
            this.messages = this.messages.filter(m => m.id !== message.message.id);
          });
          break;
        case 'edit-message':
          this.zone.run(() => {
            const index = this.messages.findIndex(m => m.id === message.message.id);
            if (index !== -1) {
              this.messages[index] = message.message;
            } else {
              // TOTO: Find the closest message to attach the retrieved message to
              //  const closestIndex = this.messages.reduce
            }
          });
          break;
        case 'reaction':
          this.zone.run(() => {
            const index = this.messages.findIndex(m => m.id === message.message.id);
            if (index !== -1) this.messages[index].reactions = message.message.reactions;
          });
          break;
        case 'heartbeat':
          this.lastHeartbeat = Date.now();
          break;
        case 'poll':
          this.zone.run(() => {
            const m = this.messages.find(x => x.id === message.messageId);
            if (m) m.poll = message.poll;
          });
          break;
        case 'topics':
          this.zone.run(() => this.chatService.loadTopics());
          break;
        case 'pins':
          this.zone.run(() => this.chatService.loadPinned());
          break;
        case 'hold-waiting':
          this.waiting.changed();
          break;
        case 'file-moderation':
          this.zone.run(() => this.mediaModeration.notify(message.file.id, message.file.status));
          break;
      }
    };
  }

  private jumpSub?: { unsubscribe(): void };
  private topicSub?: { unsubscribe(): void };

  /** Topic filter changed: show the newest messages of that topic. */
  private async reloadForTopic() {
    this.messages = [];
    this.offset = 0;
    this.hasOldMessages = true;
    this.hasNewMessages = false;
    this.openMarker = { id: 0 };
    await this.loadMessages({ resetList: true });
    this.scrollToBottom(false);
  }

  ngOnDestroy() {
    this.jumpSub?.unsubscribe();
    this.topicSub?.unsubscribe();
    this.chatService.sseClose();
    clearInterval(this.subLastHeartbeat);
  }

  async keepAliveSSE() {
    clearInterval(this.subLastHeartbeat);
    this.subLastHeartbeat = interval(10000)
      .subscribe(() => {
        if (Date.now() - this.lastHeartbeat > 60000) {
          this.lastHeartbeat = Date.now();
          this.initializeMessageListener();
        };
      });
  }

  onListScroll() {
    this.markVisibleAsRead();
    const distanceFromBottom = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    this.showScrollToBottom = distanceFromBottom > 100;
    if (distanceFromBottom < 10) {
      this.thereNewMessages = false;
    }
  }

  async scrollToBottom(smooth: boolean = true) {
    if (this.hasNewMessages) {
      this.hasNewMessages = false;
      await this.loadMessages({ resetList: true });
    }
    setTimeout(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    }, 200);
    this.thereNewMessages = false;
  }

  private async loadScheduledMessages(reload: boolean = false) {
    this._adminService.getScheduledMessages(reload)
      .then(messages => {
        this.scheduledMessages = messages;
      }).catch(() => this.toastrService.danger('', "הייתה בעיה בטעינת ההודעות המתוזמנות."));
  }

  /**
   * A jump to a message that is not on the page (a link, a quote, a jump from the search). The window is built around it by
   * TIME, the order the server keeps: the server places the message by its key, so the message's id is never compared with
   * other ids. (An id can be lower than the ids around it when the message was released from waiting; see read-position.ts.)
   */
  private async loadAround(targetId: number, mark: boolean) {
    if (this.isLoading) return;
    this.isLoading = true;
    try {
      const target = await this.chatService.getMessage(targetId).catch(() => null);
      if (!target || target.deleted || target.id == null) return; // missing, deleted or not visible to this reader
      if (this.chatService.selectedTopic && target.topic !== this.chatService.selectedTopic) return; // other topic
      const newer = await firstValueFrom(this.chatService.getMessages(targetId, this.limit, 'asc'));
      const older = await firstValueFrom(this.chatService.getMessages(targetId, this.limit, 'desc'));
      // the list is kept newest first: newer (asc returns oldest first, so reverse), the target, then older
      this.messages = [...[...newer].reverse(), target, ...older];
      this.hasNewMessages = newer.length >= this.limit;
      this.hasOldMessages = older.length >= this.limit;
      this.offset = this.messages[this.messages.length - 1]?.id ?? 0;
    } catch (error) {
      console.error('שגיאה בטעינת הודעה לקפיצה:', error);
      return;
    } finally {
      this.isLoading = false;
    }
    setTimeout(() => this.scrollToId({ messageId: targetId, smooth: false, mark }), 300);
  }

  async loadMessages(opt: LoadMsgOpt = {}) {
    // a jump to a message that is not loaded: by time, not by id (see loadAround)
    if (opt.messageId && !opt.scrollDown && !this.isLoading && !document.getElementById(String(opt.messageId))) {
      return this.loadAround(opt.messageId, !!opt.mark);
    }
    if (this.isLoading || (opt.scrollDown && !this.hasNewMessages) || (!opt.scrollDown && !this.hasOldMessages)) return;

    let startId: number;
    let resetList: boolean = opt.resetList || false;
    let direction: string = "desc";

    opt.resetList && (this.offset = 0);

    // The list is kept in display (time) order, newest first. A message released after being held keeps its
    // low id but shows on top, so "lowest id" is not "oldest shown": the ends of the list are the bookmarks.
    const maxId = this.messages[0]?.id ?? 0;
    if (opt.scrollDown) {
      direction = "asc";
      startId = maxId;
    } else {
      if (opt.messageId) {
        if (opt.messageId > maxId + this.limit) {
          resetList = true;
          this.hasNewMessages = true;
          this.hasOldMessages = true;
          startId = opt.messageId + 10;
          direction = "asc";
          opt.scrollDown = true;
        } else if (opt.messageId > maxId) {
          startId = maxId;
          direction = "asc";
          opt.scrollDown = true;
        } else {
          if (opt.messageId < this.offset - this.limit) {
            resetList = true;
            this.hasNewMessages = true;
            this.hasOldMessages = true;
            startId = opt.messageId + 10;
          } else {
            startId = this.offset;
          }
        }
      } else {
        startId = this.offset;
      }
    }

    try {
      this.isLoading = true;
      const response = await firstValueFrom(this.chatService.getMessages(startId, this.limit, direction))
      if (response && resetList && response.length === 0 && startId !== 0) {
        // Jumped to a spot that is not there (e.g. "id + 10" past the newest message): show the newest instead.
        this.hasOldMessages = true;
        this.hasNewMessages = false;
        this.isLoading = false;
        await this.loadMessages({ resetList: true }); // startId 0: cannot come back here
        setTimeout(() => {
          const el = opt.messageId && document.getElementById(String(opt.messageId));
          el ? el.scrollIntoView({ behavior: 'instant', block: 'center' }) : this.scrollToBottom(false);
        }, 300);
        return;
      }
      if (response) {
        // never show the same message twice, even if the server sends one again
        const shown = new Set(this.messages.map(m => m.id));
        const fresh = resetList ? response : response.filter(m => !shown.has(m.id));
        if (opt.scrollDown) {
          resetList ? this.messages = fresh.reverse() : this.messages.unshift(...fresh.reverse());
          this.hasNewMessages = response.length >= this.limit;
        } else {
          resetList ? this.messages = fresh : this.messages.push(...fresh);
          this.hasOldMessages = response.length >= this.limit;
        }
        this.offset = this.messages[this.messages.length - 1]?.id ?? 0;
        setTimeout(() => {
          opt.messageId && this.scrollToId({ messageId: opt.messageId, smooth: false, mark: opt.mark });
        }, 300);
      }
    } catch (error) {
      console.error('שגיאה בטעינת הודעות:', error);
    } finally {
      this.isLoading = false;
    }
  }
}
