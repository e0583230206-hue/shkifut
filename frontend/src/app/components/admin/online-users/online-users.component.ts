import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NbButtonModule, NbCardModule } from '@nebular/theme';

interface PresenceUser {
  email: string;
  name?: string;
  roles?: string[];
  online: boolean;
  connections: number;
  lastSeen: string;
}

interface PresenceResponse {
  users: PresenceUser[];
  online: number;
  retentionDays: number;
  onlineWindowSec: number;
  now: string;
}

const ROLES: Record<string, string> = { admin: 'מנהל ראשי', moderator: 'מנהל 1', reviewer: 'מנהל 2', writer: 'כותב' };

/** Admin tab "מחוברים": who is online now and when each reader was last seen (kept 30 days). Refreshes every 30 seconds. */
@Component({
  selector: 'app-online-users',
  imports: [NbCardModule, NbButtonModule],
  templateUrl: './online-users.component.html',
  styleUrl: './online-users.component.scss',
})
export class OnlineUsersComponent implements OnInit, OnDestroy {
  data: PresenceResponse | null = null;
  loading = false;
  error = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private http: HttpClient) { }

  ngOnInit() {
    this.load();
    this.timer = setInterval(() => this.load(), 30000);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  async load() {
    this.loading = true;
    try {
      this.data = await firstValueFrom(this.http.get<PresenceResponse>('/api/admin/presence'));
      this.error = false;
    } catch {
      this.error = true;
    } finally {
      this.loading = false;
    }
  }

  roles(u: PresenceUser) {
    return (u.roles ?? []).map(r => ROLES[r] ?? r).join(', ');
  }

  /** "עכשיו" / "לפני 12 דקות" / date, relative to the server's clock. */
  seen(u: PresenceUser) {
    if (u.online) return u.connections > 0 ? 'מחובר עכשיו' : 'פעיל לאחרונה';
    const now = this.data ? new Date(this.data.now).getTime() : Date.now();
    const min = Math.max(0, Math.round((now - new Date(u.lastSeen).getTime()) / 60000));
    if (min < 60) return `לפני ${min} דקות`;
    if (min < 60 * 24) return `לפני ${Math.round(min / 60)} שעות`;
    return new Date(u.lastSeen).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  get windowMinutes() {
    return this.data ? Math.round(this.data.onlineWindowSec / 60) : 5;
  }
}
