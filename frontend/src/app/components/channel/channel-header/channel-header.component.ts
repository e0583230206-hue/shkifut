import { WaitingService } from '../../../services/waiting.service';
import { StaffChatService } from '../../../services/staff-chat.service';
import { WorkNotificationsService } from '../../../services/work-notifications.service';
import { Component, EventEmitter, HostListener, Input, OnInit, Output, inject } from '@angular/core';

import {
  NbButtonModule,
  NbContextMenuModule, NbDialogService,
  NbIconModule,
  NbMenuItem,
  NbMenuService,
  NbToastrService,
  NbUserModule
} from "@nebular/theme";
import { filter } from "rxjs";
import Viewer from 'viewerjs';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { AuthService } from '../../../services/auth.service';
import { AdminService } from '../../../services/admin.service';
import { MyMessagesService } from '../../../services/my-messages.service';
import { ChatService } from '../../../services/chat.service';
import { NotificationsService } from '../../../services/notifications.service';
import { AdminPanelComponent } from "../../admin/admin-panel.component";
import { User } from '../../../models/user.model';
import { ContactComponent } from '../contact/contact.component';
import { BroadcastDialogComponent } from '../../broadcast-dialog/broadcast-dialog.component';
import { SearchComponent } from '../search/search.component';
import { HeaderSearchComponent } from '../header-search/header-search.component';
import { StarredListComponent } from '../starred/starred-list.component';
import { StarredService } from '../../../services/starred.service';
import { ThemeMode, ThemeService } from '../../../services/theme.service';
import { PersonalService } from '../../../services/personal.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DestroyRef } from '@angular/core';

@Component({
  selector: 'app-channel-header',
  imports: [
    NbButtonModule,
    NbIconModule,
    NbUserModule,
    NbContextMenuModule,
    RouterLink,
    DecimalPipe,
    HeaderSearchComponent,
],
  templateUrl: './channel-header.component.html',
  styleUrl: './channel-header.component.scss'
})
export class ChannelHeaderComponent implements OnInit {

  @Input()
  set userInfo(user: User | undefined) {
    this._userInfo = user;
    // The owner and "מנהל 1" see a number on "ניהול ערוץ": open reports + open contact messages (checked once a minute)
    if (this.isManager) this.adminService.startInboxWatch(); else this.adminService.stopInboxWatch();
    this.buildUserMenu();
  }

  private get isManager() {
    return !!this._userInfo?.privileges?.['moderator'];
  }

  /** Open reports + open contact messages (0 for everyone who is not a manager). */
  inboxTotal = 0;

  /** New replies on his items + general messages he has not opened yet (the counter of the user). */
  myTotal = 0;

  private buildUserMenu() {
    this.userMenu = [
      ...(this._userInfo && ['admin','moderator','reviewer','writer'].some(p=>this._userInfo?.privileges?.[p]) ? [{
        title: 'ניהול ערוץ',
        icon: 'people-outline',
        ...(this.inboxTotal > 0 ? { badge: { text: String(this.inboxTotal), status: 'danger' as const } } : {}),
      }] : []),
      {
        title: 'האזור האישי',
        icon: 'message-square-outline',
        ...(this.myTotal > 0 ? { badge: { text: this.myTotal > 9 ? '9+' : String(this.myTotal), status: 'success' as const } } : {}),
      },
      ...(this.work.waitingCount>0 ? [{title:'מדיה ממתינה לאישור ('+this.work.waitingCount+')',icon:'clock-outline'}] : []),
      ...(this._userInfo?.privileges?.['admin'] ? [{ title: 'הודעה לכל המשתמשים', icon: 'megaphone-outline' }] : []),
      {
        title: 'התנתק',
        icon: 'log-out',
      }
    ];
  }

  /** Counts the replies the user has not opened yet (anonymous visitors get an error and see no badge). */
  private async loadMyReplies() {
    try {
      this.myTotal = (await this.myMessages.summary()).total;
    } catch {
      this.myTotal = 0; // anonymous visitors get an error and see no counter
    }
    this.buildUserMenu();
  }

  get userInfo() {
    return this._userInfo;
  }

  private _userInfo?: User;

  @Output()
  userInfoChange: EventEmitter<User> = new EventEmitter<User>();

  userMenuTag = 'user-menu';
  userMenu: NbMenuItem[] = [];
  isSmallScreen = false;

  /** Light / dark / system switch next to the search button. */
  readonly themeMenu: NbMenuItem[] = [
    { title: 'בהיר', icon: 'sun-outline', data: 'light' },
    { title: 'כהה', icon: 'moon-outline', data: 'dark' },
    { title: 'לפי המערכת', icon: 'monitor-outline', data: 'system' },
  ];

  private myMessages = inject(MyMessagesService);
  private personal = inject(PersonalService);
  private destroyRef = inject(DestroyRef);

  constructor(
    public chatService: ChatService,
    public _authService: AuthService,
    private contextMenuService: NbMenuService,
    private toastrService: NbToastrService,
    private router: Router,
    public notificationsService: NotificationsService,
    private titleService: Title,
    private dialogService: NbDialogService,
    public themeService: ThemeService,
    private adminService: AdminService,
    public starred: StarredService,
    public staff:StaffChatService,
    public work:WorkNotificationsService,
    private waiting:WaitingService,
  ) {
  }

  get themeIcon() {
    return ({ light: 'sun-outline', dark: 'moon-outline', system: 'monitor-outline' } as Record<ThemeMode, string>)[this.themeService.mode];
  }

  @HostListener('window:resize')
  onResize() {
    this.updateScreenSize();
  }

  ngOnInit() {
    this.waiting.summary$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(()=>this.buildUserMenu());
    this.personal.summary$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(s => {
      this.myTotal = s.total; this.buildUserMenu();
    });
    this.adminService.inboxObservable.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(c => {
      this.inboxTotal = c.reports + c.contact;
      this.buildUserMenu();
    });
    this.loadMyReplies();
    // the counter is refreshed after every page change (reading a reply lowers it)
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => this.loadMyReplies());

    this.contextMenuService.onItemClick()
      .pipe(takeUntilDestroyed(this.destroyRef), filter(({ tag }) => tag === 'theme-menu'))
      .subscribe(({ item }) => this.themeService.set(item.data as ThemeMode));

    // The server already put the right title in the page (channel name / custom title / "שקיפות - חדשות ועדכונים"; the text of a message on /m/<id>).
    // Keep it: the app used to replace it with the channel name or "TheChannel", which is what the browser tab and Google (it runs the page) showed.
    const serverTitle = this.titleService.getTitle();
    this.chatService.updateChannelInfo()
      .then(() => {
        if (window.location.pathname !== '/') return; // message pages, privacy, terms: the title from the server stays
        this.titleService.setTitle(serverTitle || this.chatService.channelInfo?.name || 'שקיפות');
      });

    this.contextMenuService.onItemClick()
      .pipe(takeUntilDestroyed(this.destroyRef), filter(({ tag }) => tag === this.userMenuTag))
      .subscribe(value => {
        switch (value.item.icon) {
          case 'log-out':
            this.logout();
            break;
          case 'clock-outline':
          case 'people-outline':
            this.router.navigateByUrl('/admin');
            break;
          case 'message-square-outline':
            this.router.navigateByUrl('/my-messages');
            break;
          case 'megaphone-outline':
            this.dialogService.open(BroadcastDialogComponent, { closeOnBackdropClick: false });
            break;
        }
      });

    this.updateScreenSize();
  }

  async logout() {
    if (await this._authService.logout()) {
      this.userInfo = undefined;
      this.userInfoChange.emit(undefined);
      try {
        await this._authService.loadUserInfo();
      } catch (err: any) {
        if (err.status === 401) {
          this.router.navigate(['/login']);
        }
      }

      const path = this.router.url;
      if (path !== '/') {
        this.router.navigate(['/']);
      }

    } else {
      this.toastrService.danger("", "שגיאה בהתנתקות");
    }
  }

  private v!: Viewer;

  viewLargeImage(event: MouseEvent) {
    const target = event.target as HTMLImageElement;
    if (target.tagName === 'IMG') {
      if (!this.v) {
        this.v = new Viewer(target, {
          toolbar: false,
          transition: true,
          navbar: false,
          title: false
        });
      }
      this.v.show();
    }
  }

  updateScreenSize() {
    this.isSmallScreen = window.innerWidth < 768;
  }

  /** Built-in contact form; an external link can still be set with the "contact_us" setting. */
  /** The saved messages (the stars), in a window. */
  openStarred() {
    if (this.userInfo) this.router.navigate(['/my-messages'], {queryParams:{tab:'saved'}});
    else this.dialogService.open(StarredListComponent, { closeOnBackdropClick: true, autoFocus: false });
  }

  openSearch() {
    this.dialogService.open(SearchComponent, { closeOnBackdropClick: true, autoFocus: false });
  }

  openContactUs() {
    const external = this.chatService.channelInfo?.contact_us;
    if (external && /^https?:\/\//.test(external)) {
      window.open(external, '_blank', 'noopener');
      return;
    }
    this.dialogService.open(ContactComponent, { closeOnBackdropClick: false });
  }
}
