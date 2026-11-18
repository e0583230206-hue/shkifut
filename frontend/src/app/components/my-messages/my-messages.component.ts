import { NotificationsService } from '../../services/notifications.service';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NbButtonModule, NbCardModule, NbInputModule, NbToastrService } from '@nebular/theme';
import { MessageTimePipe } from '../../pipes/message-time.pipe';
import { AuthService } from '../../services/auth.service';
import { Broadcast, MyItem, MyMessagesService } from '../../services/my-messages.service';
import { StarredService, StarredMessage } from '../../services/starred.service';
import { ThemeService, ThemeMode } from '../../services/theme.service';
import { AccessibilityService, A11yFlag } from '../../services/accessibility.service';
import { PersonalService } from '../../services/personal.service';
import { ActivatedRoute } from '@angular/router';
import { NbDialogService, NbLayoutModule } from '@nebular/theme';
import { ContactComponent } from '../channel/contact/contact.component';

type Tab = 'news' | 'mine' | 'saved' | 'settings';

// The user's personal area: general messages from the channel, and his own reports and messages with their conversations.
@Component({
  selector: 'app-my-messages',
  imports: [NbLayoutModule, NbCardModule, NbButtonModule, NbInputModule, FormsModule, MessageTimePipe],
  templateUrl: './my-messages.component.html',
  styleUrl: './my-messages.component.scss',
})
export class MyMessagesComponent implements OnInit {
  get isStaff(){return ['admin','moderator','reviewer','writer'].some(p=>this.auth.userInfo?.privileges?.[p]);}
  tab: Tab = 'mine';
  preferenceSaving = false;
  readonly accessibilityOptions: {key: A11yFlag; label: string}[] = [
    {key:'contrast',label:'ניגודיות גבוהה'}, {key:'readable',label:'גופן קריא'},
    {key:'spacing',label:'ריווח טקסט'}, {key:'links',label:'הדגשת קישורים'},
    {key:'headings',label:'הדגשת כותרות'}, {key:'noAnim',label:'הפחתת תנועה'},
    {key:'gray',label:'גווני אפור'}, {key:'invert',label:'היפוך צבעים'}, {key:'cursor',label:'סמן מוגדל'},
  ];
  loading = true;
  error = false;
  name = '';

  broadcasts: Broadcast[] = [];
  /** how many of the newest general messages were new to him when the page opened */
  newNews = 0;

  items: MyItem[] = [];
  selected?: MyItem;
  reply = '';
  sending = false;

  constructor(
    private myMessages: MyMessagesService,
    public auth: AuthService,
    private router: Router,
    private toastrService: NbToastrService,
    public starred: StarredService,
    public theme: ThemeService,
    public a11y: AccessibilityService,
    public personal: PersonalService,
    public notifications:NotificationsService,
    private route: ActivatedRoute,
    private dialogs: NbDialogService,
  ) { }

  async ngOnInit() {
    this.loading = true; this.error = false;
    const requested = this.route.snapshot.queryParamMap.get('tab');
    if (requested && ['mine','news','saved','settings'].includes(requested)) this.tab = requested as Tab;
    await this.auth.loadUserInfo().then(u => this.name = u?.username || '').catch(() => undefined);
    void this.personal.loadPreferences();
    try {
      const [summary, news, mine] = await Promise.all([
        this.myMessages.summary(),
        this.myMessages.broadcasts(),
        this.myMessages.list(),
      ]);
      this.broadcasts = news;
      this.newNews = summary.broadcasts;
      this.items = mine;
      if (this.tab === 'news') await this.readNews();
    } catch {
      this.error = true;
    } finally {
      this.loading = false;
    }
  }

  async selectTab(tab: Tab) {
    this.tab = tab; this.selected = undefined;
    void this.router.navigate([], {relativeTo:this.route, queryParams:{tab}, replaceUrl:true});
    if (tab === 'news') await this.readNews();
    if (tab === 'saved') void this.starred.refresh();
  }
  private async readNews() {
    if (!this.broadcasts.length) return;
    try { await this.myMessages.markBroadcastsSeen(this.broadcasts[0].id); await this.personal.refresh(); }
    catch { this.toastrService.warning('', 'לא הצלחנו לסמן את ההודעות כנקראו'); }
  }
  openAdmin(){void this.router.navigateByUrl('/admin');}
  openSaved(s: StarredMessage) { void this.router.navigateByUrl('/m/' + s.id); }
  setTheme(mode: string) { this.theme.set(mode as ThemeMode); }
  newContact() { this.dialogs.open(ContactComponent, {closeOnBackdropClick:false}).onClose.subscribe(() => {
    this.myMessages.list().then(items => this.items = items).catch(() => undefined);
  }); }
  async saveReplyToast(value: boolean, key: 'replyToast'|'chatToast'|'inboxToast'|'mediaToast'|'broadcastToast'='replyToast') {
    this.preferenceSaving = true;
    try { await this.personal.savePreferences(key==='replyToast'?value:this.personal.preferences.replyToast, {[key]:value}); }
    catch { this.toastrService.danger('', 'שמירת ההעדפה נכשלה. נסו שוב'); }
    finally { this.preferenceSaving = false; }
  }

  get newMineCount(): number {
    return this.items.reduce((n, i) => n + i.unread, 0);
  }

  isNew(index: number): boolean {
    return index < this.newNews;
  }

  statusLabel(i: MyItem): string {
    if (i.status === 'handled') return 'טופל';
    if (i.status === 'closed') return 'נסגר';
    return 'פתוח';
  }

  async open(i: MyItem) {
    this.selected = i;
    this.reply = '';
    if (i.unread > 0) {
      try { await this.myMessages.markSeen(i.kind, i.id); i.unread = 0; await this.personal.refresh(); }
      catch { this.toastrService.warning('', 'לא הצלחנו לסמן את התשובה כנקראה'); }
    }
  }

  back() {
    this.selected = undefined;
  }

  async send(i: MyItem) {
    const text = this.reply.trim();
    if (!text || this.sending) return;
    this.sending = true;
    try {
      await this.myMessages.reply(i.kind, i.id, text);
      i.thread = [...i.thread, { from: 'user', text, at: new Date().toISOString() }];
      if (i.status !== 'open') i.status = 'open';
      this.reply = '';
      await this.personal.refresh();
    } catch {
      this.toastrService.danger('', 'שגיאה בשליחת ההודעה, נסו שוב');
    } finally {
      this.sending = false;
    }
  }

  home() {
    this.router.navigateByUrl('/');
  }
}
