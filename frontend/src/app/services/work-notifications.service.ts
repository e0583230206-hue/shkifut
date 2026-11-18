import { Injectable } from '@angular/core';
import { NbToastrService } from '@nebular/theme';
import { AuthService } from './auth.service';
import { AdminService } from './admin.service';
import { WaitingService, WaitingSummary } from './waiting.service';
import { PersonalService } from './personal.service';
@Injectable({providedIn:'root'})
export class WorkNotificationsService {
  waiting:WaitingSummary|null=null;
  private previous?:Set<string>; private inboxPrevious?:number; private identity='';private moderator=false;
  get waitingCount(){return (this.waiting?.images||0)+(this.waiting?.videos||0);}
  constructor(auth:AuthService,admin:AdminService,waiting:WaitingService,personal:PersonalService,toast:NbToastrService){
    auth.userChanges.subscribe(u=>{
      const identity=(u?.id||u?.email||'')+JSON.stringify(u?.privileges||{});
      if(identity!==this.identity){this.identity=identity;this.previous=undefined;this.inboxPrevious=undefined;}
      this.moderator=!!u?.privileges?.['moderator'];
      waiting.init(u);if(this.moderator)admin.startInboxWatch();else admin.stopInboxWatch();
    });
    waiting.summary$.subscribe(s=>{
      this.waiting=s;if(!s){this.previous=undefined;return;}
      const ids=new Set(s.items.map(i=>i.id));
      if(this.previous&&[...ids].some(id=>!this.previous!.has(id))&&personal.ready&&personal.preferences.mediaToast)
        toast.info('פתחו את רשימת הממתינים בערוץ לבדיקה','מדיה חדשה ממתינה לאישור',{duration:6000});
      this.previous=ids;
    });
    admin.inboxObservable.subscribe(s=>{
      if(!this.moderator)return;const n=s.contact+s.reports;
      if(this.inboxPrevious!==undefined&&n>this.inboxPrevious&&personal.ready&&personal.preferences.inboxToast)
        toast.info('הפניות והדיווחים זמינים בעמוד הניהול','פנייה חדשה לטיפול',{duration:6000});
      this.inboxPrevious=n;
    });
  }
}
