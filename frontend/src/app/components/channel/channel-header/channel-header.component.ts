import { Component, EventEmitter, HostListener, Input, OnInit, Output } from '@angular/core';

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
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { AuthService } from '../../../services/auth.service';
import { AdminService } from '../../../services/admin.service';
import { ChatService } from '../../../services/chat.service';
import { NotificationsService } from '../../../services/notifications.service';
import { AdminPanelComponent } from "../../admin/admin-panel.component";
import { User } from '../../../models/user.model';
import { ContactComponent } from '../contact/contact.component';
import { SearchComponent } from '../search/search.component';
import { ThemeMode, ThemeService } from '../../../services/theme.service';

@Component({
  selector: 'app-channel-header',
  imports: [
    NbButtonModule,
    NbIconModule,
    NbUserModule,
    NbContextMenuModule,
    RouterLink,
    DecimalPipe
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
    return !!(this._userInfo?.privileges?.['admin'] || this._userInfo?.privileges?.['moderator']);
  }

  /** Open reports + open contact messages (0 for everyone who is not a manager). */
  inboxTotal = 0;

  private buildUserMenu() {
    this.userMenu = [
      ...(this.isManager ? [{
        title: 'ניהול ערוץ',
        icon: 'people-outline',
        ...(this.inboxTotal > 0 ? { badge: { text: String(this.inboxTotal), status: 'danger' as const } } : {}),
      }] : []),
      {
        title: 'התנתק',
        icon: 'log-out',
      }
    ];
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
    this.adminService.inboxObservable.subscribe(c => {
      this.inboxTotal = c.reports + c.contact;
      this.buildUserMenu();
    });

    this.contextMenuService.onItemClick()
      .pipe(filter(({ tag }) => tag === 'theme-menu'))
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
      .pipe(filter(({ tag }) => tag === this.userMenuTag))
      .subscribe(value => {
        switch (value.item.icon) {
          case 'log-out':
            this.logout();
            break;
          case 'people-outline':
            this.dialogService.open(AdminPanelComponent, { closeOnBackdropClick: true });
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
