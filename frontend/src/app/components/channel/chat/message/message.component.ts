import { AfterViewInit, Component, ElementRef, HostListener, Input, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from "@angular/common";
import {
  NbButtonModule,
  NbCardModule, NbChatModule,
  NbDialogService,
  NbIconModule,
  NbPopoverModule,
  NbPosition,
  NbToastrService, NbUserModule
} from "@nebular/theme";
import { MarkdownComponent } from "ngx-markdown";
import Viewer from 'viewerjs';
import { YoutubePlayerComponent } from '../youtube-player/youtube-player.component';
import { NgbPopover, NgbPopoverModule } from '@ng-bootstrap/ng-bootstrap';
import { MessageTimePipe } from '../../../../pipes/message-time.pipe';
import { ChatMessage, ChatService } from '../../../../services/chat.service';
import { AdminService } from '../../../../services/admin.service';
import { AuthService } from '../../../../services/auth.service';
import { ReportComponent } from './report/report.component';
import { MediaModerationService } from '../../../../services/media-moderation.service';
import { Subscription } from 'rxjs';
import { groupImageEmbeds } from '../../../../gallery';
@Component({
  selector: 'app-message',
  imports: [
    CommonModule,
    NbCardModule,
    NbIconModule,
    NbButtonModule,
    MessageTimePipe,
    MarkdownComponent,
    NbPopoverModule,
    NgbPopoverModule,
    NbChatModule,
    NbUserModule
  ],
  templateUrl: './message.component.html',
  styleUrl: './message.component.scss'
})

export class MessageComponent implements OnInit, AfterViewInit, OnDestroy {
  protected readonly NbPosition = NbPosition;

  @Input()
  message: ChatMessage | undefined;

  @Input()
  isSchedulingMessage: boolean = false;

  @Input()
  indexId: number | undefined;

  @ViewChild(NgbPopover) popover!: NgbPopover;
  @ViewChild('media') mediaContainer!: ElementRef;

  private viewer: Viewer | null = null;
  private target: HTMLElement | null = null;

  constructor(
    private _adminService: AdminService,
    private dialogService: NbDialogService,
    protected chatService: ChatService,
    private toastrService: NbToastrService,
    public _authService: AuthService,
    private mediaModeration: MediaModerationService,
  ) { }

  reacts: string[] = [];
  private closeEmojiMenuTimeout: any;
  private isScrolling = false;
  private hoverTimer: any;
  private readonly minimalHoverMs = 200;
  private readonly matchFindCustomEmbedReg = /^\[(video|audio|image|quote)-embedded#].*/;
  private moderationSub?: Subscription;

  ngOnInit() {
    if (this.isSchedulingMessage && this.message) {
      this.message.id = this.indexId;
    }
    this.chatService.getEmojisList()
      .then(emojis => this.reacts = emojis)
      .catch(() => this.toastrService.danger('', 'שגיאה בהגדרת אימוגים'));

    window.addEventListener('scroll', this.onScroll, true);

    this.moderationSub = this.mediaModeration.updates$.subscribe(({ id }) => this.decorateMedia(id));
  }

  get isModerator(): boolean {
    return !!this._authService.userInfo?.privileges?.['moderator'];
  }

  /** Called after the markdown is rendered (and again for live status updates of one file). */
  decorateMedia(onlyId?: string) {
    this.mediaModeration.decorate(this.mediaContainer?.nativeElement, this.isModerator, onlyId);
  }

  ngOnDestroy() {
    window.removeEventListener('scroll', this.onScroll, true);
    this.moderationSub?.unsubscribe();
    this.cancelEmojiMenuClose();
    this.clearHoverTimer();
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
  }

  private scrollTimeout: any;

  onScroll = () => {
    this.isScrolling = true;
    if (this.scrollTimeout) {
      clearTimeout(this.scrollTimeout);
    }
    this.scrollTimeout = setTimeout(() => {
      this.isScrolling = false;
      this.scrollTimeout = undefined;
    }, 150)
  };

  ngAfterViewInit(): void {
    setTimeout(() => {
      const media = this.mediaContainer?.nativeElement.querySelectorAll('img, video');
      media?.forEach((item: HTMLMediaElement) => {
        if (this.chatService.channelInfo?.require_auth_for_view_files && !this._authService.userInfo) {
          const wrapper = document.createElement('div');
          wrapper.style.position = 'relative';
          wrapper.style.display = 'inline-block';
          wrapper.style.width = item.offsetWidth + 'px';
          wrapper.style.height = item.offsetHeight + 'px';

          const overlay = document.createElement('div');
          overlay.style.position = 'absolute';
          overlay.style.top = '0';
          overlay.style.left = '0';
          overlay.style.width = '100%';
          overlay.style.height = '100%';
          overlay.style.background = 'rgba(0,0,0,0.5)';
          overlay.style.backdropFilter = 'blur(4px)';
          overlay.style.display = 'flex';
          overlay.style.alignItems = 'center';
          overlay.style.justifyContent = 'center';
          overlay.style.color = 'white';
          overlay.style.fontSize = '14px';
          overlay.style.cursor = 'pointer';
          overlay.style.zIndex = '1';
          overlay.innerHTML = '<div style="text-align: center;">יש להתחבר כדי לצפות בקבצים <br>לחצו כאן להתחברות</div>';

          overlay.addEventListener('click', () => {
            this._authService.loginWithGoogle();
          });

          const parent = item.parentElement;
          if (parent) {
            parent.replaceChild(wrapper, item);
            wrapper.appendChild(item);
            wrapper.appendChild(overlay);
          }
        }
      });
    }, 1000);
  }

  editMessage(message: ChatMessage) {
    this._adminService.setEditMessage({ message, isScheduling: this.isSchedulingMessage });
  }

  deleteMessage(message: ChatMessage) {
    const confirm = window.confirm('האם אתה בטוח שברצונך למחוק את ההודעה?');
    if (confirm) {
      if (this.isSchedulingMessage) {
        this._adminService.deleteScheduledMessage(message.id);
        return;
      }
      this._adminService.deleteMessage(message.id).subscribe();
    }
  }

  openReportDialog(messageId?: number) {
    if (this.isSchedulingMessage) return;
    this.dialogService.open(ReportComponent, { closeOnBackdropClick: true, context: { messageId } });
  }

  quoteMessage(message: ChatMessage) {
    if (this.isSchedulingMessage) return;
    let newMsgText: string | undefined = message.text?.trimStart();
    let fintEmbedded = newMsgText?.match(this.matchFindCustomEmbedReg);
    if (fintEmbedded) {
      switch (fintEmbedded[1]) {
        case 'video':
          newMsgText = "וידיאו 📹";
          break;
        case 'audio':
          newMsgText = "אודיו 🎙️";
          break;
        case 'image':
          newMsgText = "תמונה 📷";
          break;
        case 'quote':
          newMsgText = "ציטוט 💬";
          break;
      }
    }
    newMsgText = newMsgText?.slice(0, 100).replace('>', '').replaceAll(/\n/g, ' ').replaceAll('*', '');
    if (message.text && message.text.length > 100) {
      newMsgText += '...';
    }

    const m = this._adminService.getEditMessage();
    if (m?.new || !m?.message) {
      let newMessage: ChatMessage = {
        text: `[quote-embedded#](${message.id}@${newMsgText})\n`
      }
      this._adminService.setEditMessage({ new: true, message: newMessage, isScheduling: this.isSchedulingMessage });
    } else {
      m.message.text = `[quote-embedded#](${message.id}@${newMsgText})\n${m.message.text}`;
      this._adminService.setEditMessage(m);
    }
  }

  private displayCache?: { text: string; out: string };

  /** Message text as rendered: consecutive images become a gallery. */
  get displayText(): string {
    const text = this.message?.text || '';
    if (this.displayCache?.text !== text) this.displayCache = { text, out: groupImageEmbeds(text) };
    return this.displayCache.out;
  }

  viewLargeImage(event: MouseEvent) {
    let target = event.target as HTMLElement;

    // Gallery: open a viewer over all of its images, starting at the clicked one ("+N" opens the 4th).
    const gallery = target.closest('.msg-gallery') as HTMLElement | null;
    if (gallery) {
      if (target.classList.contains('gallery-more')) {
        target = target.parentElement?.querySelector('img') ?? target;
      }
      const images = Array.from(gallery.querySelectorAll('img'));
      const index = images.indexOf(target as HTMLImageElement);
      if (index < 0) return;
      // The viewer runs over a detached copy: the gallery's own images are rebuilt by the media
      // decoration and include hidden ("+N") cells.
      const list = document.createElement('ul');
      for (const image of images) {
        const copy = document.createElement('img');
        copy.src = image.currentSrc || image.src;
        copy.alt = image.alt;
        list.appendChild(document.createElement('li')).appendChild(copy);
      }
      this.viewer?.destroy();
      this.viewer = new Viewer(list, {
        initialViewIndex: index,
        toolbar: { prev: true, next: true, zoomIn: true, zoomOut: true, oneToOne: false, reset: false, rotateLeft: false, rotateRight: false, flipHorizontal: false, flipVertical: false, play: false },
        navbar: true,
        transition: false, // the list is built right away (no wait for a transition that may never end)
        title: false,
      });
      this.target = null;
      this.viewer.show();
      return;
    }

    if (target.tagName === 'IMG' || target.tagName === 'I') {
      const youtubeId = target.getAttribute('youtubeid');
      if (youtubeId) {
        this.dialogService.open(YoutubePlayerComponent, { closeOnBackdropClick: true, context: { videoId: youtubeId } })
        return;
      }

      if (this.target === target && this.viewer) {
        this.viewer.show();
      } else {
        if (this.viewer) {
          this.viewer.destroy();
          this.viewer = null;
        }
        this.viewer = new Viewer(target, {
          toolbar: false,
          transition: true,
          navbar: false,
          title: false
        });
        this.target = target;
        this.viewer.show();
      }
    }
  }

  setReact(id: number | undefined, react: string) {
    if (this.isSchedulingMessage) return;
    if (!this._authService.userInfo) {
      this.toastrService.danger('', "יש להתחבר לחשבון בכדי להוסיף אימוג'ים");
      return;
    }
    if (id && react)
      this.chatService.setReact(id, react).catch(() => this.toastrService.danger('', "הייתה בעיה, נסו שנית."));
  }

  showEmojiMenu() {
    if (!this._authService.userInfo || this.isScrolling || this.message?.is_ads || this.isSchedulingMessage) return;
    this.clearHoverTimer();
    this.hoverTimer = setTimeout(() => {
      if (!this.isScrolling) {
        this.cancelEmojiMenuClose();
        this.popover.open();
      }
    }, this.minimalHoverMs);
  }

  scheduleEmojiMenuClose() {
    this.clearHoverTimer();
    this.closeEmojiMenuTimeout = setTimeout(() => {
      this.popover.close();
    }, 150);
  }

  cancelEmojiMenuClose() {
    this.clearHoverTimer();
    if (this.closeEmojiMenuTimeout) {
      clearTimeout(this.closeEmojiMenuTimeout);
      this.closeEmojiMenuTimeout = undefined;
    }
  }

  clearHoverTimer() {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = undefined;
    }
  }


  isEdited(message: ChatMessage): boolean {
    if (!message.last_edit) return false;
    const date = new Date(message.last_edit).getFullYear();
    if (isNaN(date)) return false;
    return date !== 1;
  }

  async togglePin(message: ChatMessage) {
    if (message.id == null) return;
    const pin = !this.chatService.isPinned(message.id);
    try {
      await this.chatService.setPinned(message.id, pin);
      this.toastrService.success('', pin ? 'ההודעה נעוצה' : 'הנעיצה בוטלה');
    } catch (err: any) {
      this.toastrService.danger('', err?.status === 409 ? 'אפשר לנעוץ עד 10 הודעות' : 'הפעולה נכשלה');
    }
  }

  copyLink(messageId?: number) {
    if (!messageId || this.isSchedulingMessage) return;
    const url = `${window.location.origin}/m/${messageId}`; // server adds a preview (title, image) for this address
    navigator.clipboard.writeText(url).then(() => {
      this.toastrService.success('', 'הקישור הועתק ללוח');
    });
  }
}
