import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom, Observable, Subject } from 'rxjs';
import { Channel } from '../models/channel.model';
import { ResponseResult } from '../models/response-result.model';

export type MessageType = 'md' | 'text' | 'image' | 'video' | 'audio' | 'document' | 'other';
export type Reactions = { [key: string]: number }
export interface ChatMessage {
  id?: number;
  type?: MessageType;
  text?: string;
  timestamp?: Date;
  userId?: number | null;
  author?: string;
  authorId?: string;
  last_edit?: Date;
  deleted?: boolean;
  file?: ChatFile;
  views?: number;
  reactions?: Reactions;
  is_ads?: boolean;
  topic?: string;
  poll?: Poll;
}

export interface PollOption {
  text: string;
  count: number;
}

export interface Poll {
  question: string;
  options: PollOption[];
  multiple: boolean;
  closed?: boolean;
  voters?: number;
}

export interface Topic {
  id: string;
  name: string;
  color: string;
}
export type ChatResponse = ChatMessage[];

export interface ChatFile {
  url: string;
  filename: string;
  filetype: string;
}

export interface SearchResult {
  id: number;
  timestamp: string;
  snippet: string;
  topic?: string;
}

export interface PinnedMessage {
  id: number;
  timestamp: string;
  snippet: string;
  pinnedAt: string;
}

export interface Attachment {
  file: File;
  url?: string;
  uploadProgress?: number;
  uploading?: boolean;
  embedded?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private eventSource!: EventSource;
  private emojis: string[] = [];
  public channelInfo?: Channel;

  /** Requests to show a message in the channel (search results, pinned bar, ...). */
  private jump = new Subject<number>();
  jump$ = this.jump.asObservable();

  constructor(private http: HttpClient) { }

  private pinned = new BehaviorSubject<PinnedMessage[]>([]);
  pinned$ = this.pinned.asObservable();

  isPinned(id?: number): boolean {
    return id != null && this.pinned.value.some(p => p.id === id);
  }

  async loadPinned() {
    try {
      this.pinned.next(await firstValueFrom(this.http.get<PinnedMessage[]>('/api/messages/pinned')));
    } catch {
      this.pinned.next([]);
    }
  }

  async setPinned(id: number, pinned: boolean) {
    await firstValueFrom(this.http.post<ResponseResult>('/api/admin/pin', { id, pinned }));
    await this.loadPinned();
  }

  jumpToMessage(id: number) {
    this.jump.next(id);
  }

  searchMessages(q: string, topic?: string): Promise<SearchResult[]> {
    const params: Record<string, string> = { q };
    if (topic) params['topic'] = topic;
    return firstValueFrom(this.http.get<SearchResult[]>('/api/messages/search', { params }));
  }

  /** One message, for its own page (/m/<id>). Rejects with a 404 when it does not exist or was deleted. */
  getMessage(id: number | string): Promise<ChatMessage> {
    return firstValueFrom(this.http.get<ChatMessage>(`/api/messages/${id}`));
  }

  async updateChannelInfo() {
    this.channelInfo = await firstValueFrom(this.http.get<Channel>('/api/channel/info'));
    return;
  }

  editChannelInfo(name: string, description: string, logoUrl: string): Observable<ResponseResult> {
    return this.http.post<ResponseResult>('/api/admin/edit-channel-info', { name, description, logoUrl });
  }

  getMessages(offset: number, limit: number, direction: string): Observable<ChatResponse> {
    const params: Record<string, string> = { offset: offset.toString(), limit: limit.toString(), direction };
    if (this.topic.value) params['topic'] = this.topic.value;
    return this.http.get<ChatResponse>('/api/messages', { params });
  }

  // --- topics
  private topics = new BehaviorSubject<Topic[]>([]);
  topics$ = this.topics.asObservable();
  private topic = new BehaviorSubject<string>('');
  /** The topic the channel is filtered by ('' = everything). */
  selectedTopic$ = this.topic.asObservable();

  get selectedTopic(): string {
    return this.topic.value;
  }

  topicById(id?: string): Topic | undefined {
    return id ? this.topics.value.find(t => t.id === id) : undefined;
  }

  async loadTopics() {
    try {
      const list = await firstValueFrom(this.http.get<Topic[]>('/api/topics'));
      this.topics.next(list || []);
      if (this.topic.value && !list.some(t => t.id === this.topic.value)) this.topic.next('');
    } catch {
      this.topics.next([]);
    }
  }

  selectTopic(id: string) {
    if (id !== this.topic.value) this.topic.next(id);
  }

  // --- polls
  private voteRequests = new Map<number, ((v: number[]) => void)[]>();
  private voteTimer?: ReturnType<typeof setTimeout>;

  /** The current user's choice in a poll (requests are batched into one call). */
  myVote(messageId: number): Promise<number[]> {
    return new Promise(resolve => {
      const waiting = this.voteRequests.get(messageId) ?? [];
      waiting.push(resolve);
      this.voteRequests.set(messageId, waiting);
      clearTimeout(this.voteTimer);
      this.voteTimer = setTimeout(() => this.flushMyVotes(), 60);
    });
  }

  private async flushMyVotes() {
    const batch = new Map(this.voteRequests);
    this.voteRequests.clear();
    let votes: Record<string, number[]> = {};
    try {
      votes = await firstValueFrom(this.http.get<Record<string, number[]>>('/api/polls/mine', { params: { ids: [...batch.keys()].join(',') } }));
    } catch { /* not logged in */ }
    batch.forEach((resolvers, id) => resolvers.forEach(res => res(votes[id] ?? [])));
  }

  vote(messageId: number, options: number[]): Promise<{ poll: Poll; mine: number[] }> {
    return firstValueFrom(this.http.post<{ poll: Poll; mine: number[] }>('/api/polls/vote', { messageId, options }));
  }

  closePoll(messageId: number, closed: boolean): Promise<{ poll: Poll }> {
    return firstValueFrom(this.http.post<{ poll: Poll }>('/api/admin/polls/close', { messageId, closed }));
  }

  async saveTopics(list: Topic[]): Promise<Topic[]> {
    const saved = await firstValueFrom(this.http.post<Topic[]>('/api/admin/topics', list));
    this.topics.next(saved);
    return saved;
  }

  setReact(messageId: number, react: string) {
    return firstValueFrom(this.http.post<ResponseResult>('/api/reactions/set-reactions', { messageId, emoji: react }));
  }

  async getEmojisList(reload: boolean = false): Promise<string[]> {
    if (this.emojis && !reload) return Promise.resolve(this.emojis); // הסרתי את בדיקת האורך, משום שזה יוצר קריאות מיותרות לשרת כאשר לא מוגדר אימוגים
    this.emojis = await firstValueFrom(this.http.get<string[]>('/api/emojis/list'));
    return this.emojis;
  }

  reportMessage(messageId: number, reason: string): Promise<ResponseResult> {
    return firstValueFrom(this.http.post<ResponseResult>('/api/messages/report', { messageId, reason }));
  }

  sseListener(): EventSource {
    if (this.eventSource) {
      this.eventSource.close();
    }

    this.eventSource = new EventSource('/api/events');

    this.eventSource.onopen = () => {
      console.log('Connection opened');
    };

    this.eventSource.onerror = (error) => {
      console.error('EventSource failed:', error);
    };

    return this.eventSource;
  }

  sseClose() {
    if (this.eventSource) {
      this.eventSource.close();
    }
  }
}
