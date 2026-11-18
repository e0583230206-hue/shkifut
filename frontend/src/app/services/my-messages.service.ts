import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ResponseResult } from '../models/response-result.model';

export type ItemKind = 'report' | 'contact';

// One message of a conversation, as the sender sees it (the moderators' names are never sent to him).
export interface ThreadMessage {
  from: 'admin' | 'user';
  text: string;
  at: string;
}

// The sender's own report or contact message, with its conversation.
export interface MyItem {
  kind: ItemKind;
  id: number;
  createdAt: string;
  subject?: string;
  text: string;
  status: 'open' | 'handled' | 'closed';
  unread: number;
  thread: ThreadMessage[];
}

// A general message from the owner to every user.
export interface Broadcast {
  id: number;
  title: string;
  text: string;
  at: string;
}

export interface MySummary {
  replies: number;
  broadcasts: number;
  total: number;
}

@Injectable({
  providedIn: 'root'
})
export class MyMessagesService {
  constructor(private http: HttpClient) { }

  list() {
    return firstValueFrom(this.http.get<MyItem[]>('/api/my/messages'));
  }

  summary() {
    return firstValueFrom(this.http.get<MySummary>('/api/my/summary'));
  }

  broadcasts() {
    return firstValueFrom(this.http.get<Broadcast[]>('/api/my/broadcasts'));
  }

  markBroadcastsSeen(upTo: number) {
    return firstValueFrom(this.http.post<ResponseResult>('/api/my/broadcasts/seen', { upTo }));
  }

  markSeen(kind: ItemKind, id: number) {
    return firstValueFrom(this.http.post<ResponseResult>('/api/my/messages/seen', { kind, id }));
  }

  reply(kind: ItemKind, id: number, text: string) {
    return firstValueFrom(this.http.post<ResponseResult>('/api/my/messages/reply', { kind, id, text }));
  }
}
