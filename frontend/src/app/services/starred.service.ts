import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { snippetOf } from './starred-snippet';
export { snippetOf } from './starred-snippet';
export interface StarredMessage { id: number; time: string; snippet: string; at: number; }
const STORAGE_KEY = 'tc-starred';
@Injectable({ providedIn: 'root' })
export class StarredService {
  items: StarredMessage[] = [];
  account = ''; loading = false; error = '';
  private epoch = 0; private pending = 0; private revision = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(private http: HttpClient, private auth: AuthService) {
    this.items = this.localItems();
    auth.userChanges.subscribe(u => {
      const account = u?.id || u?.email || '';
      if (account === this.account) return;
      this.account = account; this.epoch++; this.pending = 0; this.revision++;
      this.items = account ? [] : this.localItems(); this.error = ''; this.loading = false;
      if (account) void this.refresh();
    });
    window.addEventListener('storage', e => { if (e.key === STORAGE_KEY && !this.account) this.items = this.localItems(); });
    window.addEventListener('focus', () => { if (this.account) void this.refresh(); });
    setInterval(() => { if (this.account && !document.hidden) void this.refresh(); }, 60000);
  }
  get count() { return this.items.length; }
  get localCount() { return this.localItems().length; }
  get busy() { return this.loading || this.pending > 0; }
  has(id?: number) { return !!id && this.items.some(s => s.id === id); }
  async refresh() {
    if (!this.account || this.pending || this.loading) return;
    const epoch = this.epoch, revision = this.revision; this.loading = true;
    try {
      const items = await firstValueFrom(this.http.get<StarredMessage[]>('/api/my/saved'));
      if (epoch === this.epoch && revision === this.revision) { this.items = items; this.error = ''; }
    } catch { if (epoch === this.epoch) this.error = 'לא ניתן לסנכרן את השמורים כרגע. נסו שוב.'; }
    finally {
      if (epoch === this.epoch) {
        this.loading = false;
        if (revision !== this.revision && !this.pending) void this.refresh();
      }
    }
  }
  toggle(message: { id?: number; text?: string; timestamp?: string | Date }): boolean {
    const id = message.id; if (!id) return false;
    if (this.has(id)) { this.remove(id); return false; }
    const time = message.timestamp ? new Date(message.timestamp).toISOString() : '';
    this.items = [{ id, time, snippet: snippetOf(message.text || ''), at: Date.now() }, ...this.items].slice(0, 300);
    this.persist('add', [id]); return true;
  }
  remove(id: number) { this.items = this.items.filter(s => s.id !== id); this.persist('remove', [id]); }
  clear() { this.items = []; this.persist('clear', []); }
  // Explicit opt-in prevents importing another person's legacy data on a shared browser.
  importLocal() { if (this.account && !this.busy) this.persist('add', this.localItems().map(s => s.id)); }
  private persist(action: string, ids: number[]) {
    this.revision++;
    if (!this.account) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items)); } catch { this.error = 'השמירה בדפדפן נכשלה'; }
      return;
    }
    const epoch = this.epoch; this.pending++;
    this.queue = this.queue.then(async () => {
      if (epoch !== this.epoch) return;
      let failed = false;
      try { await firstValueFrom(this.http.post('/api/my/saved', { action, ids })); }
      catch { failed = true; }
      finally {
        if (epoch === this.epoch) {
          this.pending--;
          if (!this.pending) await this.refresh();
          if (failed) this.error = 'השינוי בשמורים לא נשמר בחשבון. נסו שוב.';
        }
      }
    });
  }
  private localItems(): StarredMessage[] {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(s => s && Number.isInteger(s.id) && s.id > 0).slice(0, 300)
        .map(s => ({ id: s.id, time: typeof s.time === 'string' ? s.time : '', snippet: typeof s.snippet === 'string' ? s.snippet.slice(0, 200) : '', at: Number(s.at) || 0 }));
    } catch { return []; }
  }
}
