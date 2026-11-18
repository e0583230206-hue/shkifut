import { StaffChatComponent } from './components/staff-chat/staff-chat.component';
import { WorkNotificationsService } from './services/work-notifications.service';
import { Component, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NbCardModule, NbLayoutModule } from "@nebular/theme";
import { NotificationsService } from './services/notifications.service';
import { UpdateService } from './services/update.service';
import { UpdateBannerComponent } from './components/update-banner/update-banner.component';
import { AccessibilityService } from './services/accessibility.service';
import { AccessibilityWidgetComponent } from './components/accessibility/accessibility-widget.component';
import { PersonalService } from './services/personal.service';
import { StarredService } from './services/starred.service';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet, StaffChatComponent,
    NbLayoutModule,
    NbCardModule,
    UpdateBannerComponent,
    AccessibilityWidgetComponent,
],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {

  constructor(
    private notificationsService: NotificationsService,
    private updateService: UpdateService,
    private accessibilityService: AccessibilityService,
    private personalService: PersonalService,
    private starredService: StarredService,
    private workNotifications: WorkNotificationsService,
  ) { }

  ngOnInit(): void {
    this.notificationsService.init();
    this.updateService.init();
    this.accessibilityService.init();
  }

  /** "Skip to the main content" (for the keyboard): the focus goes to the main part of the page. */
  skipToContent(e: Event) {
    e.preventDefault();
    const main = document.getElementById('main-content') || document.querySelector<HTMLElement>('main');
    if (!main) return;
    main.setAttribute('tabindex', '-1');
    main.focus();
    main.scrollIntoView({ block: 'start' });
  }
}
