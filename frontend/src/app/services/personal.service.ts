import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { NbToastrService } from '@nebular/theme';
import { AuthService } from './auth.service';
import { MyMessagesService, MySummary } from './my-messages.service';

export interface PersonalPreferences {replyToast:boolean;chatToast:boolean;inboxToast:boolean;mediaToast:boolean;broadcastToast:boolean;}
const defaults=():PersonalPreferences=>({replyToast:true,chatToast:true,inboxToast:true,mediaToast:true,broadcastToast:true});
@Injectable({ providedIn: 'root' })
export class PersonalService {
  readonly summary$ = new BehaviorSubject<MySummary>({ replies: 0, broadcasts: 0, total: 0 });
  preferences = defaults();
  ready = false;
  private identity = '';
  private epoch = 0;
  private previous?: number;
  private polling = false;
  constructor(private http: HttpClient, private auth: AuthService, private messages: MyMessagesService, private toast: NbToastrService) {
    auth.userChanges.subscribe(u => {
      const identity = u?.id || u?.email || '';
      if (identity === this.identity) return;
      this.identity = identity; this.epoch++; this.previous = undefined; this.ready = false;
      this.preferences = defaults();
      this.summary$.next({ replies: 0, broadcasts: 0, total: 0 });
      if (identity) { void this.loadPreferences(); void this.refresh(); }
    });
    setInterval(() => { if (!document.hidden) void this.refresh(); }, 60000);
    window.addEventListener('focus', () => void this.refresh());
  }
  async loadPreferences() {
    const epoch = this.epoch;
    try {
      const p = await firstValueFrom(this.http.get<PersonalPreferences>('/api/my/preferences'));
      if (epoch === this.epoch) { this.preferences = p; this.ready = true; }
    } catch { /* screen offers retry; do not toast with unknown preferences */ }
  }
  async savePreferences(replyToast: boolean, extra:Partial<PersonalPreferences>={}) {
    const epoch = this.epoch;
    const p = await firstValueFrom(this.http.post<PersonalPreferences>('/api/my/preferences', { ...this.preferences, replyToast, ...extra }));
    if (epoch === this.epoch) { this.preferences = p; this.ready = true; }
  }
  async refresh() {
    if (!this.identity || this.polling) return;
    this.polling = true; const epoch = this.epoch;
    try {
      const summary = await this.messages.summary();
      if (epoch !== this.epoch) return;
      if (this.ready && this.preferences.replyToast && this.previous !== undefined && summary.replies > this.previous) {
        this.toast.info('אפשר לקרוא אותה באזור האישי', 'תשובה חדשה מצוות שקיפות', { duration: 6000 });
      }
      if(this.ready && this.preferences.broadcastToast && this.previous!==undefined && summary.broadcasts>this.summary$.value.broadcasts) this.toast.info('הודעה מההנהלה מחכה באזור האישי','הודעה מהערוץ',{duration:5000});
      this.previous = summary.replies; this.summary$.next(summary);
    } catch { /* retain the last known counter on temporary failure */ }
    finally { this.polling = false; if (epoch !== this.epoch && this.identity) void this.refresh(); }
  }
}
