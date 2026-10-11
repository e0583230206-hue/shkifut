import { Component, Input, Renderer2, RendererStyleFlags2 } from '@angular/core';
import { DomSanitizer, SafeHtml, SafeResourceUrl } from '@angular/platform-browser';
import { Ad } from "../../../services/ads.service";

/**
 * One ad: an ad page (iframe src) or ad-network embed code. Embed code runs in a sandboxed frame WITHOUT
 * allow-same-origin, so ad scripts cannot read the site's cookies or DOM, and no frame may navigate the page.
 */
@Component({
  selector: 'app-advertising',
  imports: [],
  templateUrl: './advertising.component.html',
  styleUrl: './advertising.component.scss'
})
export class AdvertisingComponent {
  /** "side": the side column (sets its width); "feed": a block between messages. */
  @Input() mode: 'side' | 'feed' = 'side';

  _ad?: Ad;
  safeUrl: SafeResourceUrl | null = null;
  safeDoc: SafeHtml | null = null;

  get ad(): Ad | undefined {
    return this._ad;
  }

  @Input()
  set ad(ad: Ad) {
    this._ad = ad;
    this.safeUrl = ad?.src ? this.sanitizer.bypassSecurityTrustResourceUrl(ad.src) : null;
    this.safeDoc = !ad?.src && ad?.embedCode
      ? this.sanitizer.bypassSecurityTrustHtml(
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body>${ad.embedCode}</body></html>`)
      : null;
    if (this.mode === 'side' && ad?.width) {
      this.renderer.setStyle(document.getElementById('container'), '--ad-width', `${ad.width}px`, RendererStyleFlags2.DashCase);
    }
  }

  constructor(
    private sanitizer: DomSanitizer,
    private renderer: Renderer2,
  ) { }
}
