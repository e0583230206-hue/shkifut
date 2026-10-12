import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NbButtonModule, NbCardModule, NbIconModule, NbInputModule, NbToastrService } from '@nebular/theme';
import { ChatService, Topic } from '../../../services/chat.service';

/** Topic management: name, color, order. Removing a topic keeps its messages (without the chip). */
@Component({
  selector: 'app-topics',
  imports: [NbCardModule, NbButtonModule, NbIconModule, NbInputModule, FormsModule],
  templateUrl: './topics.component.html',
})
export class TopicsComponent implements OnInit {
  topics: Topic[] = [];
  saving = false;
  readonly palette = ['#3366ff', '#00b887', '#ff8a00', '#e83e8c', '#6f42c1', '#17a2b8', '#795548', '#607d8b'];

  constructor(private chatService: ChatService, private toastr: NbToastrService) { }

  async ngOnInit() {
    await this.chatService.loadTopics();
    this.chatService.topics$.subscribe(t => this.topics = t.map(x => ({ ...x }))).unsubscribe();
  }

  add() {
    this.topics.push({ id: '', name: '', color: this.palette[this.topics.length % this.palette.length] });
  }

  move(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= this.topics.length) return;
    [this.topics[i], this.topics[j]] = [this.topics[j], this.topics[i]];
  }

  remove(i: number) {
    this.topics.splice(i, 1);
  }

  async save() {
    if (this.topics.some(t => !t.name.trim())) {
      this.toastr.danger('', 'לכל נושא צריך שם');
      return;
    }
    this.saving = true;
    try {
      this.topics = (await this.chatService.saveTopics(this.topics)).map(x => ({ ...x }));
      this.toastr.success('', 'הנושאים נשמרו');
    } catch (err: any) {
      this.toastr.danger('', err?.status === 400 ? 'שם כפול, ארוך מדי או יותר מ-20 נושאים' : 'השמירה נכשלה');
    } finally {
      this.saving = false;
    }
  }
}
