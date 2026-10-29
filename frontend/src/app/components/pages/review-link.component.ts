import { AfterViewInit, Component, ElementRef, inject, ViewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { MediaModerationService } from '../../services/media-moderation.service';
import { AuthService } from '../../services/auth.service';

/**
 * /review/<fileId>: the link in the "video waits for approval" notification. Shows the video with the moderator's bar
 * ("הצג כמו הקוראים", "בדיקת דמויות" with the approve button), the same as under the message.
 */
@Component({
  selector: 'app-review-link',
  template: `
    <div class="review-page">
      <h5>{{ title }}</h5>
      <div #host class="review-host"></div>
      @if (message) { <p class="review-message">{{ message }}</p> }
    </div>
  `,
  styles: [`.review-page { max-width: 640px; margin: 24px auto; padding: 0 16px; } .review-message { color: var(--tc-warn-fg, #7a5200); }`],
})
export class ReviewLinkComponent implements AfterViewInit {
  private route = inject(ActivatedRoute);
  private moderation = inject(MediaModerationService);
  private auth = inject(AuthService);
  @ViewChild('host') host?: ElementRef<HTMLElement>;
  message = '';
  title = 'סרטון לבדיקה ואישור';

  async ngAfterViewInit() {
    const id = this.route.snapshot.paramMap.get('fileId') ?? '';
    const el = this.host?.nativeElement;
    if (!/^[0-9a-f]{40}$/.test(id) || !el) {
      this.message = 'הקישור אינו תקין';
      return;
    }
    const user = await this.auth.loadUserInfo().catch(() => undefined);
    if (!user?.privileges?.['moderator'] && !user?.privileges?.['reviewer']) {
      this.message = 'הדף הזה למנחים ולמאשרים בלבד';
      return;
    }
    // ?kind=image: an image that waits for a review (the banner for approvers); otherwise a video, as in the notification link
    const isImage = this.route.snapshot.queryParamMap.get('kind') === 'image';
    if (isImage) this.title = 'תמונה לבדיקה';
    const media = document.createElement(isImage ? 'img' : 'video');
    media.setAttribute('src', `/api/files/${id}`);
    el.appendChild(media);
    await this.moderation.decorate(el, true);
  }
}
