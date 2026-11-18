import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, BehaviorSubject } from 'rxjs';
import { ResponseResult } from '../models/response-result.model';
import { User } from '../models/user.model';
interface GoogleAuthValues {
  googleOauthUrl: string;
  googleOauthScope: string;
  googleClientId: string;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  public userInfo?: User;
  private requestVersion=0;
  readonly userChanges = new BehaviorSubject<User | undefined>(undefined);

  constructor(
    private _http: HttpClient,
  ) {
    setInterval(()=>{if(this.userInfo&&!document.hidden)void this.loadUserInfo(true).catch(()=>undefined);},30000);
    window.addEventListener('focus', () => {
      if (this.userInfo) void this.loadUserInfo(true).catch(() => undefined);
    });
  }

  async loginWithGoogle() {
    try {
      const googleAuthValues: GoogleAuthValues = await firstValueFrom(this._http.get<GoogleAuthValues>('/auth/google'));
      const state = crypto.randomUUID()
      const params = new URLSearchParams({
        client_id: googleAuthValues.googleClientId,
        redirect_uri: window.location.origin + '/login',
        scope: googleAuthValues.googleOauthScope,
        state: state,
        response_type: 'code',
        access_type: 'offline',
      });

      localStorage.setItem('google_oauth_state', state);
      window.location.href = `${googleAuthValues.googleOauthUrl}?${params.toString()}`;
    } catch (err: any) {
      throw err;
    }
  }

  async login(code: string) {
    try {
      let res = await firstValueFrom(this._http.post<ResponseResult>('/auth/login', { code }));
      return res.success;
    } catch (err: any) {
      this.userInfo = undefined;
      throw err;
    }
  }

  async logout() {
    let res = await firstValueFrom(this._http.post<ResponseResult>('/auth/logout', {}));
    if (res.success) {
      this.requestVersion++;
      this.userInfo = undefined;
      this.userChanges.next(undefined);
    }
    return res.success;
  }

  async loadUserInfo(force = false) {
    if(!force&&this.userInfo)return this.userInfo;
    const version=++this.requestVersion;
    try {
      const user=await firstValueFrom(this._http.get<User>('/api/user-info'));
      if(version===this.requestVersion){this.userInfo=user;this.userChanges.next(user);}
    } catch(err:any){
      if(version===this.requestVersion&&(err.status===401||err.status===403||err.status===404)){
        this.userInfo=undefined;this.userChanges.next(undefined);
      }
      throw err;
    }
    return this.userInfo;
  }
}
