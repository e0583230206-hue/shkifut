import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';
import { ChatService, Topic } from '../../../../services/chat.service';

/** Topic filter chips above the messages (shown only when the channel has topics). */
@Component({
  selector: 'app-topic-bar',
  templateUrl: './topic-bar.component.html',
  styleUrl: './topic-bar.component.scss'
})
export class TopicBarComponent implements OnInit, OnDestroy {
  topics: Topic[] = [];
  selected = '';
  private sub?: Subscription;

  constructor(private chatService: ChatService) { }

  ngOnInit() {
    this.sub = combineLatest([this.chatService.topics$, this.chatService.selectedTopic$]).subscribe(([topics, selected]) => {
      this.topics = topics;
      this.selected = selected;
    });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  select(id: string) {
    this.chatService.selectTopic(id);
  }
}
