import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { PersonalService } from './personal.service';
import { NbToastrService } from '@nebular/theme';
export interface StaffFile { id:string; name:string; mime:string; size:number; }
export interface StaffMessage { id:number; text:string; at:string; name:string; mine:boolean; files:StaffFile[]; }
@Injectable({providedIn:'root'})
export class StaffChatService {
  enabled=false; open=false; unread=0; messages:StaffMessage[]=[]; error=''; loading=false;
  identity=''; private epoch=0; private refreshAgain=false; private previous?:number;
  constructor(private http:HttpClient, auth:AuthService, private personal:PersonalService, private toast:NbToastrService) {
    auth.userChanges.subscribe(u=>{
      const enabled=!!u && ['admin','moderator','reviewer','writer'].some(p=>u.privileges?.[p]);
      const identity=enabled ? u!.id||u!.email : '';
      if(identity===this.identity)return;
      this.epoch++;this.identity=identity;this.enabled=enabled;this.open=false;this.unread=0;this.messages=[];this.previous=undefined;this.error='';
      document.body.classList.remove('staff-chat-open');
      if(enabled)void this.refresh();
    });
    setInterval(()=>{if(!document.hidden)void this.refresh();},8000);
    window.addEventListener('focus',()=>void this.refresh());
  }
  toggle(){this.open=!this.open;document.body.classList.toggle('staff-chat-open',this.open);if(this.open)void this.refresh();}
  async refresh(){
    if(!this.enabled)return;if(this.loading){this.refreshAgain=true;return;}
    this.loading=true;const epoch=this.epoch;
    try {
      const s=await firstValueFrom(this.http.get<{unread:number;latest:number}>('/api/staff/summary'));
      if(epoch!==this.epoch)return;
      if(this.previous!==undefined && s.latest>this.previous && s.unread>this.unread && !this.open && this.personal.ready && this.personal.preferences.chatToast)
        this.toast.info('פתחו את צ׳אט הצוות לקריאה','הודעה חדשה בצוות',{duration:5000});
      this.previous=s.latest;this.unread=s.unread;
      if(this.open){
        const after=this.messages.at(-1)?.id;
        const list=await firstValueFrom(this.http.get<StaffMessage[]>('/api/staff/messages'+(after?'?after='+after:'')));
        if(epoch!==this.epoch)return;
        this.messages=after?[...this.messages,...list.filter(m=>!this.messages.some(x=>x.id===m.id))]:list;
      }
      this.error='';
    } catch(e:any){if(epoch===this.epoch){this.error='לא ניתן לעדכן את הצ׳אט. נסו שוב.';if(e.status===403||e.status===401){this.enabled=false;this.open=false;this.messages=[];this.unread=0;document.body.classList.remove('staff-chat-open');}}}
    finally{this.loading=false;if((epoch!==this.epoch||this.refreshAgain)&&this.enabled){this.refreshAgain=false;void this.refresh();}}
  }
  async older(){const first=this.messages[0]?.id;if(!first)return;const epoch=this.epoch;const list=await firstValueFrom(this.http.get<StaffMessage[]>('/api/staff/messages?before='+first));if(epoch===this.epoch)this.messages=[...list,...this.messages];return list.length;}
  async seen(id:number){if(!this.open||document.hidden)return;const epoch=this.epoch;await firstValueFrom(this.http.post('/api/staff/seen',{upTo:id}));if(epoch===this.epoch)await this.refresh();}
  async send(text:string,files:StaffFile[]){const epoch=this.epoch;await firstValueFrom(this.http.post<StaffMessage>('/api/staff/messages',{text,files:files.map(f=>f.id)}));if(epoch===this.epoch)await this.refresh();}
  upload(file:File){const data=new FormData();data.append('file',file);return firstValueFrom(this.http.post<StaffFile>('/api/staff/upload',data));}
}
