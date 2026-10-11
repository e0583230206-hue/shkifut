import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Ad {
  src: string;
  width: number; // Width in pixels
}

@Injectable({
  providedIn: 'root'
})
export class AdsService {

  constructor(
    private http: HttpClient
  ) { }

  async getAds(): Promise<Ad> {
    return firstValueFrom(this.http.get<Ad>('/api/ads/settings'))
  }
}
