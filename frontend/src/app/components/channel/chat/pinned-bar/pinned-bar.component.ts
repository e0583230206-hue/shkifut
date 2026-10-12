import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { NbButtonModule, NbIconModule, NbToastrService } from '@nebular/theme';
import { Subscription } from 'rxjs';
import { ChatService, PinnedMessage } from '../../../../services/chat.service';
import { AuthService } from '../../../../services/auth.service';

/** Pinned messages bar (newest pin first). Clicking jumps to the shown pin and advances to the next one. */
@Component({
  selector: 'app-pinned-bar',
  imports: [NbIconModule, NbButtonModule],
  templateUrl: './pinned-bar.component.html',
  styleUrl: './pinned-bar.component.scss'
})
export class PinnedBarComponent implements OnInit, OnDestroy {
  pins: PinnedMessage[] = [];
  index = 0;
  top = 0;
  private sub?: Subscription;

  constructor(private chatService: ChatService, public authService: AuthService, private toastr: NbToastrService) { }

  ngOnInit() {
    this.sub = this.chatService.pinned$.subscribe(pins => {
      this.pins = pins;
      if (this.index >= pins.length) this.index = 0;
    });
    this.chatService.loadPinned();
    setTimeout(() => this.measure(), 300);
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  get current(): PinnedMessage | undefined {
    return this.pins[this.index];
  }

  /** Stick right under the fixed channel header. */
  @HostListener('window:resize')
  measure() {
    this.top = Math.round(document.querySelector('nb-layout-header')?.getBoundingClientRect().bottom ?? 0);
  }

  open() {
    const pin = this.current;
    if (!pin) return;
    this.chatService.jumpToMessage(pin.id);
    if (this.pins.length > 1) this.index = (this.index + 1) % this.pins.length;
  }

  async unpin(event: Event) {
    event.stopPropagation();
    const pin = this.current;
    if (!pin) return;
    try {
      await this.chatService.setPinned(pin.id, false);
    } catch {
      this.toastr.danger('', 'ביטול הנעיצה נכשל');
    }
  }
}
