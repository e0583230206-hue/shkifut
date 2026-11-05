import { Component, inject } from '@angular/core';
import { UpdateService } from '../../services/update.service';

/**
 * "The site was updated": a card that rises from the bottom of the screen, with a spinning refresh mark, a glowing line on top and a button that
 * refreshes the page. Motion is switched off for readers who asked their system for less of it.
 */
@Component({
  selector: 'app-update-banner',
  template: `
    @if (update.visible) {
    <div class="update-banner" role="status" aria-live="polite" dir="rtl">
      <span class="glow" aria-hidden="true"></span>
      <span class="badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path class="arrow" d="M20 11a8 8 0 0 0-14.3-4.6M4 5v4.5h4.5"/>
          <path class="arrow" d="M4 13a8 8 0 0 0 14.3 4.6M20 19v-4.5h-4.5"/>
        </svg>
        <i class="spark s1"></i><i class="spark s2"></i><i class="spark s3"></i>
      </span>
      <span class="copy">
        <strong class="title">עדכנו את האתר</strong>
        <span class="sub">יש גרסה חדשה עם שיפורים. רעננו כדי לראות אותה</span>
      </span>
      <button class="refresh" type="button" (click)="update.refresh()">
        <span>לחצו לרענון</span>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19 12H5M11 6l-6 6 6 6"/>
        </svg>
      </button>
      <button class="close" type="button" (click)="update.dismiss()" aria-label="סגור" title="אחר כך">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    }
  `,
  styles: [`
    /* blue and violet as in the site, and the red of the logo (--ub-r, --ub-r2) */
    :host { --ub-a: #2f4bff; --ub-b: #7a3cff; --ub-c: #19c3ff; --ub-r: #e5202e; --ub-r2: #ff5a4d; }

    .update-banner {
      position: fixed;
      bottom: 20px;
      left: 50%;
      z-index: 2000;
      display: flex;
      align-items: center;
      gap: 14px;
      width: min(560px, calc(100vw - 24px));
      box-sizing: border-box;
      padding: 14px 16px;
      border-radius: 20px;
      overflow: hidden;
      background: var(--tc-surface, #ffffff);
      color: var(--tc-text, #1b2140);
      border: 1px solid var(--tc-border, rgba(47, 75, 255, 0.18));
      box-shadow: 0 18px 50px rgba(34, 48, 140, 0.28), 0 2px 8px rgba(0, 0, 0, 0.08);
      transform: translateX(-50%);
      animation: ub-rise 0.7s cubic-bezier(0.2, 0.9, 0.3, 1.15) both;
    }

    /* a line of light along the top edge */
    .glow {
      position: absolute;
      inset: 0 0 auto 0;
      height: 3px;
      background: linear-gradient(90deg, var(--ub-r), var(--ub-r2), var(--ub-b), var(--ub-a), var(--ub-b), var(--ub-r2), var(--ub-r));
      background-size: 200% 100%;
      animation: ub-flow 3s linear infinite;
    }

    .badge {
      position: relative;
      flex: none;
      display: grid;
      place-items: center;
      width: 46px;
      height: 46px;
      border-radius: 14px;
      color: #fff;
      background: linear-gradient(135deg, var(--ub-r2), var(--ub-r) 55%, #a5121f);
      box-shadow: 0 6px 16px rgba(229, 32, 46, 0.42);
      animation: ub-pulse 2.4s ease-in-out infinite;
    }
    .badge svg { transform-origin: 50% 50%; animation: ub-spin 3.2s cubic-bezier(0.65, 0, 0.35, 1) infinite; }

    .spark {
      position: absolute;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ffd84d;
      opacity: 0;
      animation: ub-spark 2.4s ease-in-out infinite;
    }
    .s1 { top: -3px; inset-inline-end: -2px; }
    .s2 { bottom: -2px; inset-inline-start: -3px; animation-delay: 0.8s; background: var(--ub-c); }
    .s3 { top: 6px; inset-inline-start: -6px; animation-delay: 1.6s; width: 4px; height: 4px; }

    .copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .title { font-size: 1.05rem; line-height: 1.25; }
    .sub { font-size: 0.82rem; opacity: 0.68; line-height: 1.35; }

    .refresh {
      position: relative;
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 0;
      border-radius: 999px;
      padding: 10px 18px;
      overflow: hidden;
      color: #fff;
      font-weight: 700;
      font-size: 0.95rem;
      cursor: pointer;
      background: linear-gradient(135deg, var(--ub-a), var(--ub-b));
      box-shadow: 0 6px 16px rgba(47, 75, 255, 0.38);
      transition: transform 0.18s ease, box-shadow 0.18s ease;
    }
    /* a bright band that sweeps across the button now and then */
    .refresh::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(110deg, transparent 35%, rgba(255, 255, 255, 0.55) 50%, transparent 65%);
      transform: translateX(-120%);
      animation: ub-shine 3.4s ease-in-out 1s infinite;
    }
    .refresh svg { transition: transform 0.2s ease; }
    .refresh:hover { transform: translateY(-2px); box-shadow: 0 10px 22px rgba(47, 75, 255, 0.5); }
    .refresh:hover svg { transform: translateX(-4px); }
    .refresh:active { transform: translateY(0) scale(0.98); }
    .refresh:focus-visible, .close:focus-visible { outline: 3px solid var(--ub-c); outline-offset: 2px; }

    .close {
      flex: none;
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      opacity: 0.5;
      cursor: pointer;
      transition: opacity 0.15s ease, background-color 0.15s ease;
    }
    .close:hover { opacity: 1; background: rgba(120, 130, 170, 0.18); }

    @keyframes ub-rise {
      0%   { opacity: 0; transform: translate(-50%, 60px) scale(0.94); }
      100% { opacity: 1; transform: translate(-50%, 0) scale(1); }
    }
    @keyframes ub-flow  { to { background-position: -200% 0; } }
    @keyframes ub-spin  { 0%, 55% { transform: rotate(0); } 100% { transform: rotate(360deg); } }
    @keyframes ub-pulse {
      0%, 100% { box-shadow: 0 6px 16px rgba(229, 32, 46, 0.42), 0 0 0 0 rgba(229, 32, 46, 0.5); }
      50%      { box-shadow: 0 6px 16px rgba(229, 32, 46, 0.42), 0 0 0 10px rgba(229, 32, 46, 0); }
    }
    @keyframes ub-spark {
      0%, 100% { opacity: 0; transform: scale(0.3); }
      40%      { opacity: 1; transform: scale(1.2); }
      70%      { opacity: 0; transform: scale(0.6) translateY(-4px); }
    }
    @keyframes ub-shine { 0%, 60% { transform: translateX(-120%); } 100% { transform: translateX(120%); } }

    @media (max-width: 480px) {
      .update-banner { bottom: 12px; padding: 12px; gap: 10px; flex-wrap: wrap; }
      .copy { flex-basis: calc(100% - 100px); }
      .refresh { flex: 1; justify-content: center; order: 3; }
      .badge { width: 40px; height: 40px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .update-banner, .glow, .badge, .badge svg, .spark, .refresh::after { animation: none !important; }
      .update-banner { transform: translateX(-50%); }
      .spark { display: none; }
    }
  `],
})
export class UpdateBannerComponent {
  update = inject(UpdateService);
}
