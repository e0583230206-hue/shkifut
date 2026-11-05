import { Component, ElementRef, HostListener, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NbIconModule } from '@nebular/theme';
import { Subject, Subscription, debounceTime, distinctUntilChanged } from 'rxjs';
import { ChatService, SearchResult } from '../../../services/chat.service';
import { MessageTimePipe } from '../../../pipes/message-time.pipe';
import { Part, highlight } from '../search/search.component';

/**
 * The search field of the top bar: a wide round field that is always there; what is typed is searched as the reader types, and the results open under
 * it (the matched words highlighted). Choosing one jumps to the message. On a phone the bar has the small search button (the dialog) instead.
 */
@Component({
  selector: 'app-header-search',
  imports: [FormsModule, NbIconModule, MessageTimePipe],
  templateUrl: './header-search.component.html',
  styleUrl: './header-search.component.scss',
})
export class HeaderSearchComponent implements OnDestroy {
  query = '';
  results: (SearchResult & { parts: Part[] })[] = [];
  searching = false;
  searched = false;
  error = false;
  open = false;
  private input$ = new Subject<string>();
  private sub: Subscription;

  constructor(private chatService: ChatService, private host: ElementRef<HTMLElement>) {
    this.sub = this.input$.pipe(debounceTime(350), distinctUntilChanged()).subscribe(q => this.search(q));
  }

  ngOnDestroy() {
    this.sub.unsubscribe();
  }

  onInput() {
    this.open = true;
    this.input$.next(this.query.trim());
  }

  onFocus() {
    if (this.query.trim().length >= 2) this.open = true;
  }

  async search(q: string) {
    this.error = false;
    if (q.length < 2) {
      this.results = [];
      this.searched = false;
      return;
    }
    this.searching = true;
    try {
      const found = await this.chatService.searchMessages(q);
      if (q !== this.query.trim()) return; // a newer query is on its way
      const terms = q.split(/\s+/).filter(Boolean);
      this.results = found.map(r => ({ ...r, parts: highlight(r.snippet, terms) }));
      this.searched = true;
    } catch {
      this.error = true;
    } finally {
      this.searching = false;
    }
  }

  choose(result: SearchResult) {
    this.chatService.jumpToMessage(result.id);
    this.open = false;
  }

  clear() {
    this.query = '';
    this.results = [];
    this.searched = false;
    this.open = false;
    this.input$.next('');
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(e: Event) {
    if (!this.host.nativeElement.contains(e.target as Node)) this.open = false;
  }

  @HostListener('keydown.escape')
  onEscape() {
    this.open = false;
  }
}
