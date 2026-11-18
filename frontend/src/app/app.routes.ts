import { Routes, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from './services/auth.service';
import { LoginComponent } from './components/login/login.component';
import { ChannelComponent } from './components/channel/channel.component';
import { AuthGuard } from "./services/chat-guard.guard";
import { StaticPageComponent } from './components/pages/static-page.component';
import { MessagePageComponent } from './components/pages/message-page.component';
import { ReviewLinkComponent } from './components/pages/review-link.component';
import { MyMessagesComponent } from './components/my-messages/my-messages.component';

import { AdminPanelComponent } from './components/admin/admin-panel.component';

export const routes: Routes = [
  {path:'admin',component:AdminPanelComponent,canActivate:[()=>{const auth=inject(AuthService),router=inject(Router);return auth.loadUserInfo().then(u=>u&&['admin','moderator','reviewer','writer'].some(p=>u.privileges?.[p])?true:router.createUrlTree(['/'])).catch(()=>router.createUrlTree(['/login']));}]},
  { path: 'login', component: LoginComponent },
  {
    path: '',
    component: ChannelComponent,
    canActivate: [AuthGuard],
  },
  // Shareable message address (the server adds preview tags): the page shows the message itself, with a button to open it in the channel.
  // It must not redirect to the channel by itself: a search engine that runs the page would see the home page and drop the address.
  { path: 'my-messages', component: MyMessagesComponent, canActivate: [() => {
    const auth = inject(AuthService), router = inject(Router);
    return auth.loadUserInfo().then(u => u ? true : router.createUrlTree(['/login']))
      .catch(() => router.createUrlTree(['/login']));
  }] },
  { path: 'm/:id', component: MessagePageComponent },
  { path: 'm/:id/:slug', component: MessagePageComponent }, // the readable address: the server redirects /m/<id> to it
  // The link in the "video waits for approval" notification: the video with the moderator's bar and the review grid.
  { path: 'review/:fileId', component: ReviewLinkComponent, canActivate: [AuthGuard] },
  { path: 'privacy', component: StaticPageComponent, data: { page: 'privacy' }, title: 'מדיניות פרטיות' },
  { path: 'terms', component: StaticPageComponent, data: { page: 'terms' }, title: 'תנאי שימוש' },
  { path: 'accessibility', component: StaticPageComponent, data: { page: 'accessibility' }, title: 'הצהרת נגישות' },
  { path: '**', component: StaticPageComponent, data: { page: 'not-found' }, title: 'הדף לא נמצא' }
];
