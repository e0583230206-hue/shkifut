import { Component, Input, OnChanges } from '@angular/core';
import { NbToastrService } from '@nebular/theme';
import { ChatService, Poll } from '../../../../../services/chat.service';
import { AuthService } from '../../../../../services/auth.service';

/**
 * A poll inside a message. Results are shown after voting, when the poll is closed, and to writers.
 * Single choice votes on click; multiple choice uses checkboxes and a "vote" button.
 */
@Component({
  selector: 'app-poll',
  templateUrl: './poll.component.html',
  styleUrl: './poll.component.scss'
})
export class PollComponent implements OnChanges {
  @Input() poll!: Poll;
  @Input() messageId?: number;
  @Input() preview = false; // scheduled message: not votable yet

  mine: number[] = [];
  selection = new Set<number>();
  busy = false;
  private loadedFor?: number;

  constructor(private chatService: ChatService, public authService: AuthService, private toastr: NbToastrService) { }

  ngOnChanges() {
    if (this.messageId && this.messageId !== this.loadedFor && !this.preview && this.authService.userInfo) {
      this.loadedFor = this.messageId;
      this.chatService.myVote(this.messageId).then(v => this.mine = v);
    }
  }

  get isWriter(): boolean {
    return !!this.authService.userInfo?.privileges?.['writer'];
  }

  get showResults(): boolean {
    return !this.preview && (this.mine.length > 0 || !!this.poll.closed || this.isWriter);
  }

  get canVote(): boolean {
    return !this.preview && !this.poll.closed;
  }

  percent(count: number): number {
    const total = this.poll.multiple ? (this.poll.voters || 0) : this.poll.options.reduce((s, o) => s + o.count, 0);
    return total ? Math.round((count * 100) / total) : 0;
  }

  async choose(index: number) {
    if (!this.canVote || this.busy) return;
    if (!this.authService.userInfo) {
      this.toastr.info('', 'יש להתחבר כדי להצביע');
      return;
    }
    if (this.poll.multiple) {
      if (this.selection.has(index)) this.selection.delete(index);
      else this.selection.add(index);
      return;
    }
    await this.send([index]);
  }

  async submitMultiple() {
    if (this.selection.size) await this.send([...this.selection].sort((a, b) => a - b));
  }

  async retract() {
    await this.send([]);
  }

  async toggleClosed() {
    if (!this.messageId) return;
    try {
      this.poll = (await this.chatService.closePoll(this.messageId, !this.poll.closed)).poll;
    } catch {
      this.toastr.danger('', 'הפעולה נכשלה');
    }
  }

  private async send(options: number[]) {
    if (!this.messageId) return;
    this.busy = true;
    try {
      const res = await this.chatService.vote(this.messageId, options);
      this.poll = res.poll;
      this.mine = res.mine;
      this.selection.clear();
    } catch (err: any) {
      const msg = err?.status === 409 ? 'הסקר סגור' : err?.status === 401 ? 'יש להתחבר כדי להצביע' : 'ההצבעה נכשלה';
      this.toastr.danger('', msg);
    } finally {
      this.busy = false;
    }
  }
}
