import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ResponseResult } from '../models/response-result.model';

export interface ContactForm {
  name: string;
  email: string;
  phone: string;
  subject: string;
  message: string;
  website: string;    // honeypot - hidden from people, left empty
  elapsedMs: number;  // how long the form was open (bots submit instantly)
}

export interface ContactMessage {
  id: number;
  name: string;
  email: string;
  phone: string;
  subject: string;
  message: string;
  createdAt: string;
  handled: boolean;
  userEmail?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ContactService {
  constructor(private http: HttpClient) { }

  send(form: ContactForm) {
    return firstValueFrom(this.http.post<ResponseResult>('/api/contact', form));
  }

  list(status: 'open' | 'all') {
    return firstValueFrom(this.http.get<ContactMessage[]>('/api/admin/contact', { params: { status } }));
  }

  setHandled(id: number, handled: boolean) {
    return firstValueFrom(this.http.post<ResponseResult>('/api/admin/contact/set', { id, handled }));
  }
}
