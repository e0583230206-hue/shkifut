import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { User } from '../models/user.model';

export interface WaitingItem {
  id: string;
  kind: 'video' | 'image';
  filename?: string;
  uploadedAt?: string;
}

/** What waits for a decision (GET /api/admin/hold/waiting): videos readers do not get yet, images shown fully blurred until a moderator reviews. */
export interface WaitingSummary {
  videos: number;
  images: number;
  items: WaitingItem[];
}

const REFRESH_MS = 60_000;

/**
 * The count for the bar at the top. Only approvers and owners ask (the server refuses anybody else): it loads once, again every minute,
 * and when the live stream says something changed ('hold-waiting', which carries no numbers).
 */
@Injectable({ providedIn: 'root' })
export class WaitingService {
  private readonly _summary = new BehaviorSubject<WaitingSummary | null>(null);
  readonly summary$ = this._summary.asObservable();
  private enabled = false;
  private timer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;

  constructor(private http: HttpClient) { }

  static canSee(user?: User): boolean {
    return !!(user?.privileges?.['moderator'] || user?.privileges?.['reviewer']);
  }

  /** Call once the user is known. Safe to call again. */
  init(user?: User) {
    if (this.enabled || !WaitingService.canSee(user)) return;
    this.enabled = true;
    this.load();
    this.timer = setInterval(() => this.load(), REFRESH_MS);
  }

  /** The live stream reported a change: ask again soon (many changes in a row are one question). */
  changed() {
    if (!this.enabled) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.load(), 1000);
  }

  private async load() {
    try {
      this._summary.next(await firstValueFrom(this.http.get<WaitingSummary>('/api/admin/hold/waiting')));
    } catch {
      // not allowed any more, or offline: keep what is shown, the next round tries again
    }
  }
}
