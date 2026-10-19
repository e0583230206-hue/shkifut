import { Routes } from '@angular/router';
import { LoginComponent } from './components/login/login.component';
import { ChannelComponent } from './components/channel/channel.component';
import { AuthGuard } from "./services/chat-guard.guard";
import { StaticPageComponent } from './components/pages/static-page.component';
import { MessageLinkComponent } from './components/pages/message-link.component';
import { ReviewLinkComponent } from './components/pages/review-link.component';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  {
    path: '',
    component: ChannelComponent,
    canActivate: [AuthGuard],
  },
  // Shareable message address (the server adds preview tags); opens the channel at that message.
  { path: 'm/:id', component: MessageLinkComponent },
  // The link in the "video waits for approval" notification: the video with the moderator's bar and the review grid.
  { path: 'review/:fileId', component: ReviewLinkComponent, canActivate: [AuthGuard] },
  { path: 'privacy', component: StaticPageComponent, data: { page: 'privacy' }, title: 'מדיניות פרטיות' },
  { path: 'terms', component: StaticPageComponent, data: { page: 'terms' }, title: 'תנאי שימוש' },
  { path: '**', component: StaticPageComponent, data: { page: 'not-found' }, title: 'הדף לא נמצא' }
];