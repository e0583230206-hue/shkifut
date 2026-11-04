import { Injectable } from '@angular/core';

/**
 * Tells the reader that the site was updated. The server puts the version of the frontend into the page (<meta name="app-version">) and
 * answers /api/version with the current one; when the two differ, the page that is open is old and the reader is offered a refresh.
 * Without the meta tag (a development server) nothing is checked.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private static readonly CHECK_EVERY_MS = 3 * 60 * 1000;

  /** True while a newer version than the open page is waiting. */
  available = false;
  private loaded = '';
  private dismissedFor = '';
  private latest = '';
  private started = false;

  get visible(): boolean {
    return this.available && this.latest !== this.dismissedFor;
  }

  init(): void {
    if (this.started || typeof document === 'undefined') return;
    this.loaded = document.querySelector('meta[name="app-version"]')?.getAttribute('content') || '';
    if (!this.loaded) return;
    this.started = true;
    setInterval(() => this.check(), UpdateService.CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.check();
    });
  }

  async check(): Promise<void> {
    try {
      const res = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      const version = (await res.json())?.version;
      if (typeof version !== 'string' || !version) return;
      this.latest = version;
      this.available = version !== this.loaded;
    } catch {
      // offline or the server is restarting: try again later
    }
  }

  /** "Not now": the notice comes back only when an even newer version appears. */
  dismiss(): void {
    this.dismissedFor = this.latest;
  }

  refresh(): void {
    window.location.reload();
  }
}
