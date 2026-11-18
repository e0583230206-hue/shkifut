import { Component, ElementRef, ViewChild, AfterViewChecked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { StaffChatService, StaffFile } from '../../services/staff-chat.service';
@Component({selector:'app-staff-chat',imports:[FormsModule,DatePipe],templateUrl:'./staff-chat.component.html',styleUrl:'./staff-chat.component.scss'})
export class StaffChatComponent implements AfterViewChecked {
  @ViewChild('history') history?:ElementRef<HTMLElement>;
  text='';files:StaffFile[]=[];busy=false;error='';olderAvailable=true;private bottom=true;private last=0;private seen=0;private wasOpen=false;private identity='';
  constructor(public chat:StaffChatService){}
  ngAfterViewChecked(){
    if(this.identity!==this.chat.identity){this.identity=this.chat.identity;this.text='';this.files=[];this.last=0;this.seen=0;this.error='';this.olderAvailable=true;}
    if(!this.chat.open){this.wasOpen=false;return;}
    if(!this.wasOpen){this.bottom=true;this.wasOpen=true;}
    const el=this.history?.nativeElement;if(!el)return;
    const last=this.chat.messages.at(-1)?.id||0;
    if(last!==this.last&&this.bottom){el.scrollTop=el.scrollHeight;this.last=last;}
    if(this.bottom&&last>this.seen&&!document.hidden){this.seen=last;void this.chat.seen(last).catch(()=>this.seen=0);}
  }
  scroll(){const el=this.history?.nativeElement;if(el)this.bottom=el.scrollHeight-el.scrollTop-el.clientHeight<70;}
  async older(){this.bottom=false;try{this.olderAvailable=!!(await this.chat.older());}catch{this.error='טעינת ההיסטוריה נכשלה';}}
  async attach(event:Event){const input=event.target as HTMLInputElement;const selected=Array.from(input.files||[]);input.value='';if(selected.length+this.files.length>4){this.error='אפשר לצרף עד ארבעה קבצים';return;}this.busy=true;this.error='';const identity=this.chat.identity;try{for(const f of selected){if(f.size>25*1024*1024)throw Error();const uploaded=await this.chat.upload(f);if(identity!==this.chat.identity)return;this.files.push(uploaded);}}catch{this.error='העלאת הקובץ נכשלה. הגודל המרבי הוא 25MB';}finally{this.busy=false;}}
  async send(){if(this.busy||(!this.text.trim()&&!this.files.length))return;this.busy=true;this.error='';try{await this.chat.send(this.text,this.files);this.text='';this.files=[];this.bottom=true;}catch{this.error='ההודעה לא נשלחה. התוכן נשמר כאן לניסיון נוסף.';}finally{this.busy=false;}}
}
