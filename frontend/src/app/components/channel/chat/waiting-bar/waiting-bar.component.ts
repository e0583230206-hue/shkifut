import { AsyncPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { WaitingService } from '../../../../services/waiting.service';

/** A bar above the messages for approvers and owners: how many videos and images wait for a decision, and a button to the oldest. */
@Component({
  selector: 'app-waiting-bar',
  imports: [AsyncPipe, RouterLink],
  templateUrl: './waiting-bar.component.html',
  styleUrl: './waiting-bar.component.scss'
})
export class WaitingBarComponent {
  waiting = inject(WaitingService);

  label(videos: number, images: number): string {
    const parts: string[] = [];
    if (videos) parts.push(videos === 1 ? 'סרטון אחד לא פורסם' : `${videos} סרטונים לא פורסמו`);
    if (images) parts.push(images === 1 ? 'תמונה אחת מוצגת מטושטשת' : `${images} תמונות מוצגות מטושטשות`);
    return parts.join(' · ');
  }
}
