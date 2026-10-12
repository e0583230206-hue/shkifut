import { Component, ElementRef, OnDestroy, ViewChild, AfterViewInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NbButtonModule, NbCardModule, NbDialogRef, NbIconModule, NbInputModule } from '@nebular/theme';
import { Subject, Subscription, debounceTime, distinctUntilChanged } from 'rxjs';
import { ChatService, SearchResult } from '../../../services/chat.service';
import { MessageTimePipe } from '../../../pipes/message-time.pipe';

type Part = { text: string; hit: boolean };

/** Channel search: results with the matched words highlighted; choosing one jumps to the message. */
@Component({
  selector: 'app-search',
  imports: [NbCardModule, NbButtonModule, NbIconModule, NbInputModule, FormsModule, MessageTimePipe],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss'
})
export class SearchComponent implements AfterViewInit, OnDestroy {
  query = '';
  results: (SearchResult & { parts: Part[] })[] = [];
  searching = false;
  searched = false;
  error = false;
  private input$ = new Subject<string>();
  private sub: Subscription;
  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  constructor(public dialogRef: NbDialogRef<SearchComponent>, private chatService: ChatService) {
    this.sub = this.input$.pipe(debounceTime(350), distinctUntilChanged()).subscribe(q => this.search(q));
  }

  ngAfterViewInit() {
    setTimeout(() => this.searchInput?.nativeElement.focus(), 50);
  }

  ngOnDestroy() {
    this.sub.unsubscribe();
  }

  onInput() {
    this.input$.next(this.query.trim());
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

  open(result: SearchResult) {
    this.chatService.jumpToMessage(result.id);
    this.dialogRef.close();
  }
}

/** Splits text into plain/highlighted parts (niqqud-insensitive), rendered without innerHTML. */
function highlight(text: string, terms: string[]): Part[] {
  const strip = (s: string) => s.replace(/[֑-ׇ]/g, '').toLowerCase();
  const chars = [...text];
  const plain = chars.map(c => strip(c));
  const flat = plain.join('');
  const marks = new Array(chars.length).fill(false);
  // map positions in `flat` back to char indexes
  const owner: number[] = [];
  plain.forEach((p, i) => { for (let k = 0; k < p.length; k++) owner.push(i); });
  for (const term of terms.map(strip).filter(Boolean)) {
    let from = 0;
    for (let at = flat.indexOf(term, from); at >= 0; at = flat.indexOf(term, from)) {
      for (let k = at; k < at + term.length; k++) marks[owner[k]] = true;
      from = at + term.length;
    }
  }
  const parts: Part[] = [];
  chars.forEach((c, i) => {
    const last = parts[parts.length - 1];
    if (last && last.hit === marks[i]) last.text += c;
    else parts.push({ text: c, hit: marks[i] });
  });
  return parts;
}
