import { Component, OnDestroy, OnInit } from "@angular/core";
import { RouterLink, ActivatedRoute } from '@angular/router';
import { WorkNotificationsService } from '../../services/work-notifications.service';
import { StaffChatService } from '../../services/staff-chat.service';
import { Subscription } from "rxjs";
import { NbCardModule, NbLayoutModule, NbMenuItem, NbMenuModule, NbMenuService, NbSidebarModule } from "@nebular/theme";
import { EmojisComponent } from "./emojis/emojis.component";
import { SettingsComponent } from "./settings/settings.component";
import { PrivilegDashboardComponent } from "./privileg-dashboard/privileg-dashboard.component";
import { ChannelInfoFormComponent } from "../channel/channel-info-form/channel-info-form.component";
import { ReportsComponent } from "./reports/reports.component";
import { StatisticsComponent } from "./statistics/statistics.component";
import { AdminService } from "../../services/admin.service";
import { ContactInboxComponent } from "./contact-inbox/contact-inbox.component";
import { AdsSettingsComponent } from "./ads-settings/ads-settings.component";
import { TopicsComponent } from "./topics/topics.component";
import { OnlineUsersComponent } from "./online-users/online-users.component";
import { AuthService } from "../../services/auth.service";

@Component({
  selector: 'admin-dashboard',
  imports: [
    NbLayoutModule, RouterLink,
    NbSidebarModule,
    NbMenuModule,
    NbCardModule,
    EmojisComponent,
    SettingsComponent,
    PrivilegDashboardComponent,
    ChannelInfoFormComponent,
    ReportsComponent,
    StatisticsComponent,
    ContactInboxComponent,
    AdsSettingsComponent,
    TopicsComponent,
    OnlineUsersComponent
],
  templateUrl: './admin-panel.component.html',
  styleUrls: ['./admin-panel.component.scss']
})
export class AdminPanelComponent implements OnInit, OnDestroy {

  private inboxSub?: Subscription;
  private menuSub?: Subscription;
  private authSub?: Subscription;
  counts={contact:0,reports:0};
  get moderator(){return !!this.authService.userInfo?.privileges?.['moderator'];}
  get owner(){return !!this.authService.userInfo?.privileges?.['admin'];}
  get reviewer(){return this.moderator||!!this.authService.userInfo?.privileges?.['reviewer'];}
  private allowed(icon:any){return icon==='grid-outline'||(['settings-2-outline','shield-outline','pricetags-outline'].includes(icon)?this.owner:this.moderator);}
  private allMenu:NbMenuItem[]=[];
  private roleKey="";

  readonly info = "info";
  readonly settings = "settings";
  readonly users = "users";
  readonly emojis = "emojis";
  readonly openReports = "open-reports";
  readonly closedReports = "closed-reports";
  readonly allReports = "all-reports";
  readonly statistics = "statistics";
  readonly contact = "contact";
  readonly ads = "ads";
  readonly topics = "topics";
  readonly online = "online";

  selectedMenuItem = 'summary';

  navigationMenu: NbMenuItem[] = [{title:'סקירה כללית',icon:'grid-outline'},
    {
      title: 'פרטי ערוץ',
      icon: 'info-outline',
      selected: false
    },
    {
      title: 'הגדרות',
      icon: 'settings-2-outline',
    },
    {
      title: 'הרשאות',
      icon: 'shield-outline',
    },
    {
      title: 'סטטיסטיקות',
      icon: 'bar-chart-outline',
    },
    {
      title: 'מחוברים',
      icon: 'activity-outline',
    },
    {
      title: 'נושאים',
      icon: 'hash-outline',
    },
    {
      title: 'פרסומות',
      icon: 'pricetags-outline',
    },
    {
      title: 'פניות',
      icon: 'email-outline',
    },
    {
      title: "אימוג'ים",
      icon: 'smiling-face-outline',
    },
    {
      title: 'דיווחים',
      icon: 'alert-triangle-outline',
      children: [
        {
          title: 'פתוחים',
          icon: 'alert-triangle-outline',
        },
        {
          title: 'סגורים',
          icon: 'checkmark-circle-outline',
        },
        {
          title: 'כל הדיווחים',
          icon: 'list-outline',
        }
      ],
    }
  ];

  constructor(
    private menuService: NbMenuService,
    private authService: AuthService,
    private adminService: AdminService,
    public work:WorkNotificationsService,
    public staff:StaffChatService,
    private route:ActivatedRoute
  ) { }

  ngOnInit(): void {
    this.allMenu=this.navigationMenu;
    this.authSub=this.authService.userChanges.subscribe(()=>{
      const key=JSON.stringify(this.authService.userInfo?.privileges||{});
      if(this.roleKey===key)return;this.roleKey=key;
      this.navigationMenu=this.allMenu.filter(i=>this.allowed(i.icon));
      this.selectedMenuItem='summary';
      this.navigationMenu.forEach(i=>i.selected=i.icon==='grid-outline');
    });
    this.handleMenuItemClick();
    if(this.moderator)this.adminService.refreshInbox();
    this.inboxSub = this.adminService.inboxObservable.subscribe(c => {
      this.counts=c;
      this.setBadge('email-outline', c.contact);
      this.setBadge('alert-triangle-outline', c.reports);
    });
  }

  ngOnDestroy(): void {
    this.inboxSub?.unsubscribe();this.menuSub?.unsubscribe();this.authSub?.unsubscribe();
  }

  private setBadge(icon: string, count: number) {
    const item = this.navigationMenu.find(i => i.icon === icon);
    if (item) item.badge = count > 0 ? { text: String(count), status: 'danger' } : undefined;
  }

  handleMenuItemClick() {
    this.menuSub=this.menuService.onItemClick().subscribe((event) => {
      if(event.tag!=='admin-panel'||!this.allowed(event.item.icon))return;
      this.navigationMenu.forEach((item) => item.selected = false);
      event.item.selected = true;

      switch (event.item.icon) {
        case 'grid-outline':this.selectedMenuItem='summary';break;
        case 'info-outline':
          this.selectedMenuItem = 'summary';
          break;
        case 'settings-2-outline':
          this.selectedMenuItem = this.settings;
          break;
        case 'shield-outline':
          this.selectedMenuItem = this.users;
          break;
        case 'smiling-face-outline':
          this.selectedMenuItem = this.emojis;
          break;
        case 'alert-triangle-outline':
          this.selectedMenuItem = this.openReports;
          break;
        case 'checkmark-circle-outline':
          this.selectedMenuItem = this.closedReports;
          break;
        case 'list-outline':
          this.selectedMenuItem = this.allReports;
          break;
        case 'bar-chart-outline':
          this.selectedMenuItem = this.statistics;
          break;
        case 'activity-outline':
          this.selectedMenuItem = this.online;
          break;
        case 'email-outline':
          this.selectedMenuItem = this.contact;
          break;
        case 'pricetags-outline':
          this.selectedMenuItem = this.ads;
          break;
        case 'hash-outline':
          this.selectedMenuItem = this.topics;
          break;
      }
    });
  }
}