import { Component, OnInit } from "@angular/core";
import { NbCardModule, NbLayoutModule, NbMenuItem, NbMenuModule, NbMenuService, NbSidebarModule } from "@nebular/theme";
import { EmojisComponent } from "./emojis/emojis.component";
import { SettingsComponent } from "./settings/settings.component";
import { PrivilegDashboardComponent } from "./privileg-dashboard/privileg-dashboard.component";
import { ChannelInfoFormComponent } from "../channel/channel-info-form/channel-info-form.component";
import { ReportsComponent } from "./reports/reports.component";
import { StatisticsComponent } from "./statistics/statistics.component";
import { ContactInboxComponent } from "./contact-inbox/contact-inbox.component";
import { AdsSettingsComponent } from "./ads-settings/ads-settings.component";
import { TopicsComponent } from "./topics/topics.component";
import { OnlineUsersComponent } from "./online-users/online-users.component";
import { AuthService } from "../../services/auth.service";

@Component({
  selector: 'admin-dashboard',
  imports: [
    NbLayoutModule,
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
export class AdminPanelComponent implements OnInit {

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

  selectedMenuItem = this.info;

  navigationMenu: NbMenuItem[] = [
    {
      title: 'פרטי ערוץ',
      icon: 'info-outline',
      selected: true
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
    private authService: AuthService
  ) { }

  ngOnInit(): void {
    // "Who is online" is for the owner and "מנהל 1" (the server enforces it too)
    if (!this.authService.userInfo?.privileges?.['admin'] && !this.authService.userInfo?.privileges?.['moderator']) {
      this.navigationMenu = this.navigationMenu.filter(i => i.icon !== 'activity-outline');
    }
    this.handleMenuItemClick()
  }

  handleMenuItemClick() {
    this.menuService.onItemClick().subscribe((event) => {
      this.navigationMenu.forEach((item) => item.selected = false);
      event.item.selected = true;

      switch (event.item.icon) {
        case 'info-outline':
          this.selectedMenuItem = this.info;
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