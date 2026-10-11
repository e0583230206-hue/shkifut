import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Ad {
  enabled: boolean;
  src: string;        // ad page URL (side column / in-feed frame)
  width: number;      // side column width in pixels
  embedCode: string;  // ad-network embed code, rendered in a sandboxed frame
  feedEvery: number;  // an ad after every N messages (0 = none)
  feedHeight: number; // in-feed ad height in pixels
}

@Injectable({
  providedIn: 'root'
})
export class AdsService {
  private ad?: Promise<Ad>;

  constructor(
    private http: HttpClient
  ) { }

  /** Fetched once per page load and shared by the side column and the feed. */
  getAds(): Promise<Ad> {
    this.ad ??= firstValueFrom(this.http.get<Ad>('/api/ads/settings'));
    return this.ad;
  }
}
