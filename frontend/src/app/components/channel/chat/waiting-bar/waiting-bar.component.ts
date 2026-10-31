import { AsyncPipe } from '@angular/common';
import { Component, ElementRef, HostBinding, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { WaitingService } from '../../../../services/waiting.service';

/** A bar above the messages for approvers and owners: how many videos and images wait for a decision, and a button to the oldest. */
@Component({
  selector: 'app-waiting-bar',
  imports: [AsyncPipe, RouterLink],
  templateUrl: './waiting-bar.component.html',
  styleUrl: './waiting-bar.component.scss'
})
export class WaitingBarComponent implements OnInit, OnDestroy {
  waiting = inject(WaitingService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private resize?: ResizeObserver;

  /** Stick right under the fixed channel header (the chat opens scrolled to the newest message, so a bar at the top of the list would be out of sight). */
  @HostBinding('style.top.px') top = 0;

  ngOnInit() {
    this.measure();
    setTimeout(() => this.measure(), 300);
    // The pinned-message bar sticks in the same place: it moves down by the height of this bar (--waiting-bar-h).
    this.resize = new ResizeObserver(() =>
      document.documentElement.style.setProperty('--waiting-bar-h', `${this.host.nativeElement.offsetHeight}px`));
    this.resize.observe(this.host.nativeElement);
  }

  ngOnDestroy() {
    this.resize?.disconnect();
    document.documentElement.style.removeProperty('--waiting-bar-h');
  }

  @HostListener('window:resize')
  measure() {
    this.top = Math.round(document.querySelector('nb-layout-header')?.getBoundingClientRect().bottom ?? 0);
  }

  label(videos: number, images: number): string {
    const parts: string[] = [];
    if (videos) parts.push(videos === 1 ? 'סרטון אחד לא פורסם' : `${videos} סרטונים לא פורסמו`);
    if (images) parts.push(images === 1 ? 'תמונה אחת מוצגת מטושטשת' : `${images} תמונות מוצגות מטושטשות`);
    return parts.join(' · ');
  }
}
