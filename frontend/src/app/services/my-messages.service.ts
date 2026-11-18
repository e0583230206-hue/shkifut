import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ResponseResult } from '../models/response-result.model';

// The personal area: only the user's own reports and contact messages, and the replies written to them.
export interface MyMessage {
  kind: 'report' | 'contact';
  id: number;
  createdAt: string;
  subject?: string;
  text: string;
  reply?: string;
  repliedAt?: string;
  unread: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class MyMessagesService {
  constructor(private http: HttpClient) { }

  list() {
    return firstValueFrom(this.http.get<MyMessage[]>('/api/my/messages'));
  }

  markSeen(kind: MyMessage['kind'], id: number) {
    return firstValueFrom(this.http.post<ResponseResult>('/api/my/messages/seen', { kind, id }));
  }
}
