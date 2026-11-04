import { Component, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NbCardModule, NbLayoutModule } from "@nebular/theme";
import { NotificationsService } from './services/notifications.service';
import { UpdateService } from './services/update.service';
import { UpdateBannerComponent } from './components/update-banner/update-banner.component';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    NbLayoutModule,
    NbCardModule,
    UpdateBannerComponent,
],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {

  constructor(
    private notificationsService: NotificationsService,
    private updateService: UpdateService,
  ) { }

  ngOnInit(): void {
    this.notificationsService.init();
    this.updateService.init();
  }
}
