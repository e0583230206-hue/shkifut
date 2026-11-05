import { Component, ElementRef, HostListener, ViewChild, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { A11yFlag, AccessibilityService, TEXT_STEPS } from '../../services/accessibility.service';

interface Tile {
  flag: A11yFlag;
  label: string;
  /** the inside of a 24x24 svg (stroke icons); written here, never taken from outside */
  icon: SafeHtml;
}

/**
 * The accessibility button and its menu: a round button at the corner of the screen that opens a panel (text size, contrast, grey scale, links, headings,
 * readable font, spacing, no animation, big cursor, reset and a link to the accessibility statement). Everything works from the keyboard: Enter / Space open,
 * Tab moves inside, Esc closes and the focus goes back to the button. The state of every choice is told with aria-pressed.
 */
@Component({
  selector: 'app-accessibility-widget',
  imports: [RouterLink],
  template: `
    <button #trigger class="a11y-trigger" type="button" (click)="toggle()" [attr.aria-expanded]="open" aria-controls="a11y-panel"
      aria-label="תפריט נגישות" title="נגישות">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="4.6" r="2.1" fill="currentColor" stroke="none"/>
        <path d="M4.5 8.6l7.5 1.5 7.5-1.5M12 10.1v4.4M12 14.5l-3.4 6M12 14.5l3.4 6"/>
      </svg>
    </button>

    @if (open) {
    <div #panel id="a11y-panel" class="a11y-panel" role="dialog" aria-modal="false" aria-labelledby="a11y-title" dir="rtl" tabindex="-1">
      <div class="a11y-head">
        <h2 id="a11y-title">תפריט נגישות</h2>
        <button class="a11y-close" type="button" (click)="close()" aria-label="סגירת תפריט הנגישות">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <div class="a11y-text" role="group" aria-label="גודל הטקסט">
        <button type="button" class="a11y-step" (click)="a11y.changeText(-1)" [disabled]="a11y.state.text === 0" aria-label="הקטנת הטקסט">A−</button>
        <span class="a11y-size" aria-live="polite">גודל הטקסט: {{ a11y.textPercent }}%</span>
        <button type="button" class="a11y-step" (click)="a11y.changeText(1)" [disabled]="a11y.state.text === maxText" aria-label="הגדלת הטקסט">A+</button>
      </div>

      <div class="a11y-grid">
        @for (t of tiles; track t.flag) {
        <button type="button" class="a11y-tile" [class.on]="a11y.state[t.flag]" [attr.aria-pressed]="a11y.state[t.flag]" (click)="a11y.toggle(t.flag)">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" [innerHTML]="t.icon"></svg>
          <span>{{ t.label }}</span>
        </button>
        }
      </div>

      <div class="a11y-foot">
        <button type="button" class="a11y-reset" (click)="a11y.reset()" [disabled]="!a11y.changed">איפוס הגדרות</button>
        <a class="a11y-statement" routerLink="/accessibility" (click)="close()">הצהרת נגישות</a>
      </div>
    </div>
    }
  `,
  styles: [`
    :host { --a11y-blue: #2f4bff; }

    .a11y-trigger {
      position: fixed;
      inset-inline-start: 14px;
      bottom: 104px;
      z-index: 1900;
      display: grid;
      place-items: center;
      width: 48px;
      height: 48px;
      padding: 0;
      border: 2px solid #fff;
      border-radius: 50%;
      background: var(--a11y-blue);
      color: #fff;
      box-shadow: 0 6px 18px rgba(20, 28, 90, 0.4);
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
    }
    .a11y-trigger:hover { transform: scale(1.07); background: #1f36d9; }
    .a11y-trigger:focus-visible { outline: 3px solid #ffbf00; outline-offset: 3px; }

    .a11y-panel {
      position: fixed;
      inset-inline-start: 14px;
      bottom: 164px;
      z-index: 2100;
      box-sizing: border-box;
      width: min(360px, calc(100vw - 28px));
      max-height: calc(100vh - 190px);
      overflow-y: auto;
      padding: 14px;
      border-radius: 18px;
      background: var(--tc-surface, #fff);
      color: var(--tc-text, #1b2140);
      border: 1px solid var(--tc-border, #d5d9e8);
      box-shadow: 0 18px 50px rgba(16, 19, 32, 0.38);
      animation: a11y-in 0.18s ease-out both;
    }
    .a11y-panel:focus { outline: none; }

    .a11y-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .a11y-head h2 { margin: 0; font-size: 1.15rem; font-weight: 800; }
    .a11y-close {
      display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
      border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer;
    }
    .a11y-close:hover { background: rgba(120, 130, 170, 0.18); }

    .a11y-text {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      margin-bottom: 10px; padding: 8px 10px; border-radius: 12px;
      background: var(--tc-surface-2, #f1f3fa);
    }
    .a11y-size { font-weight: 700; font-size: 0.92rem; }
    .a11y-step {
      min-width: 52px; height: 36px; border: 1px solid var(--a11y-blue); border-radius: 999px;
      background: #fff; color: var(--a11y-blue); font-weight: 800; font-size: 1rem; cursor: pointer;
    }
    .a11y-step:hover:not(:disabled) { background: var(--a11y-blue); color: #fff; }
    .a11y-step:disabled { opacity: 0.4; cursor: default; }

    .a11y-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .a11y-tile {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      min-height: 78px; padding: 8px 4px; text-align: center;
      border: 1.5px solid var(--tc-border, #d5d9e8); border-radius: 12px;
      background: var(--tc-surface, #fff); color: inherit; font-size: 0.8rem; font-weight: 600; line-height: 1.2; cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .a11y-tile:hover { border-color: var(--a11y-blue); }
    .a11y-tile.on { background: var(--a11y-blue); border-color: var(--a11y-blue); color: #fff; }

    .a11y-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px; }
    .a11y-reset {
      padding: 8px 14px; border: 1px solid #c0392b; border-radius: 999px; background: transparent;
      color: #c0392b; font-weight: 700; cursor: pointer;
    }
    .a11y-reset:hover:not(:disabled) { background: #c0392b; color: #fff; }
    .a11y-reset:disabled { opacity: 0.4; cursor: default; }
    .a11y-statement { font-weight: 700; color: var(--a11y-blue); text-decoration: underline; }

    .a11y-panel button:focus-visible, .a11y-panel a:focus-visible { outline: 3px solid #ffbf00; outline-offset: 2px; }

    @keyframes a11y-in { from { opacity: 0; transform: translateY(10px); } }
    @media (prefers-reduced-motion: reduce) { .a11y-panel { animation: none; } .a11y-trigger { transition: none; } }
  `],
})
export class AccessibilityWidgetComponent {
  readonly a11y = inject(AccessibilityService);
  readonly maxText = TEXT_STEPS.length - 1;
  open = false;

  @ViewChild('trigger') trigger?: ElementRef<HTMLButtonElement>;
  @ViewChild('panel') panel?: ElementRef<HTMLElement>;

  private readonly sanitizer = inject(DomSanitizer);
  private svg = (inner: string): SafeHtml => this.sanitizer.bypassSecurityTrustHtml(inner);

  readonly tiles: Tile[] = [
    { flag: 'contrast', label: 'ניגודיות גבוהה', icon: this.svg('<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>') },
    { flag: 'invert', label: 'ניגודיות הפוכה', icon: this.svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>') },
    { flag: 'gray', label: 'גווני אפור', icon: this.svg('<rect x="4" y="4" width="11" height="11" rx="2"/><rect x="9" y="9" width="11" height="11" rx="2" fill="currentColor" fill-opacity="0.35"/>') },
    { flag: 'links', label: 'הדגשת קישורים', icon: this.svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>') },
    { flag: 'headings', label: 'הדגשת כותרות', icon: this.svg('<path d="M6 5v14M18 5v14M6 12h12"/>') },
    { flag: 'readable', label: 'גופן קריא', icon: this.svg('<path d="M3 19l5-13 5 13M5 14h6M15 19v-8m0 2.5a3 3 0 0 1 5 0V19"/>') },
    { flag: 'spacing', label: 'ריווח טקסט', icon: this.svg('<path d="M4 6h16M4 12h16M4 18h16"/><path d="M12 8.5v-1.5M12 17v-1.5" />') },
    { flag: 'noAnim', label: 'עצירת אנימציות', icon: this.svg('<rect x="7" y="5" width="3.2" height="14" rx="1" fill="currentColor"/><rect x="13.8" y="5" width="3.2" height="14" rx="1" fill="currentColor"/>') },
    { flag: 'cursor', label: 'סמן גדול', icon: this.svg('<path d="M6 3l13 8-6 2 4 7-3 1.4-4-7-4 4z" fill="currentColor" fill-opacity="0.25"/>') },
  ];

  toggle() {
    this.open ? this.close() : this.openPanel();
  }

  private openPanel() {
    this.open = true;
    setTimeout(() => this.panel?.nativeElement.focus(), 0);
  }

  close(returnFocus = true) {
    this.open = false;
    if (returnFocus) setTimeout(() => this.trigger?.nativeElement.focus(), 0);
  }

  @HostListener('keydown.escape')
  onEscape() {
    if (this.open) this.close();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(e: Event) {
    if (!this.open) return;
    const target = e.target as Node;
    const inside = this.panel?.nativeElement.contains(target) || this.trigger?.nativeElement.contains(target);
    if (!inside) this.close(false);
  }
}
