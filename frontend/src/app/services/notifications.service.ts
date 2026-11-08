import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { NbToastrService } from '@nebular/theme';
import { firstValueFrom } from 'rxjs';
import { FirebaseApp, FirebaseOptions, initializeApp } from 'firebase/app';
import { getMessaging, onMessage, getToken, deleteToken } from 'firebase/messaging';


interface NotificationsConfig {
  enableNotifications: boolean,
  vapid?: string,
  firebaseConfig?: FirebaseOptions,
}

@Injectable({
  providedIn: 'root'
})
export class NotificationsService {
  public initialized = false;
  private app: FirebaseApp | null = null;
  private messaging: any;
  public config: NotificationsConfig | null = null;

  constructor(
    private http: HttpClient,
    private tostrService: NbToastrService,
  ) { }

  async init() {
    if (this.initialized) return;

    await firstValueFrom(this.http.get<NotificationsConfig>('/api/channel/notifications-config'))
      .then((config) => {
        this.config = config;
      });

    if (!this.config) return;

    if (this.config.enableNotifications) {
      if (!this.config.firebaseConfig) return;

      this.app = initializeApp(this.config.firebaseConfig);
      this.messaging = getMessaging(this.app);
      this.initialized = true;
      this.refreshState();

      onMessage(this.messaging, (payload) => {
        //this.tostrService.success("", 'התראה חדשה!');
      });
      return;
    }
    return;
  }


  // Per device: "on" is remembered in this browser only, so each reader decides for themselves.
  public enabled = false;
  private readonly storageKey = 'notifications-token';

  private storedToken(): string {
    try { return localStorage.getItem(this.storageKey) || ''; } catch { return ''; }
  }

  private storeToken(token: string) {
    try {
      if (token) localStorage.setItem(this.storageKey, token);
      else localStorage.removeItem(this.storageKey);
    } catch { /* storage blocked: the switch still works for this visit */ }
  }

  // Called after init: the bell is "on" only if this browser still allows notifications and has a saved token.
  refreshState() {
    this.enabled = typeof Notification !== 'undefined' && Notification.permission === 'granted' && !!this.storedToken();
  }

  // One click: on -> off, off -> on.
  async toggle() {
    if (this.enabled) {
      await this.turnOff();
    } else {
      await this.turnOn();
    }
  }

  private async turnOn() {
    if (typeof Notification === 'undefined') {
      this.tostrService.warning("", 'הדפדפן הזה לא תומך בהתראות');
      return;
    }
    if (Notification.permission === 'denied') {
      this.tostrService.warning("", 'ההתראות חסומות בדפדפן. לחצו על המנעול ליד כתובת האתר ושנו ל"אפשר"');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const token = await getToken(this.messaging, { vapidKey: this.config?.vapid });
      if (!token || !(await this.subscribeNotifications(token))) throw new Error('no token');
      this.storeToken(token);
      this.enabled = true;
      this.tostrService.success("", 'התראות הופעלו');
    } catch {
      this.tostrService.danger("", 'שגיאה בהגדרת התראות!');
    }
  }

  private async turnOff() {
    const token = this.storedToken();
    try {
      if (token) {
        await firstValueFrom(this.http.post('/api/channel/notifications-unsubscribe', { token }));
      }
      try { await deleteToken(this.messaging); } catch { /* already gone */ }
      this.storeToken('');
      this.enabled = false;
      this.tostrService.success("", 'התראות כובו');
    } catch {
      this.tostrService.danger("", 'שגיאה בכיבוי התראות, נסו שוב');
    }
  }

  async subscribeNotifications(token: string): Promise<boolean> {
    if (!token) return false;
    return firstValueFrom(this.http.post<boolean>('/api/channel/notifications-subscribe', { token }))
  }

}