import { Injectable } from '@angular/core';
import { NbThemeService } from '@nebular/theme';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'tc-theme';
const THEME_LIGHT = 'custom';
const THEME_DARK = 'custom-dark';

export function storedThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* private window or blocked storage: the default */ }
  return 'light';
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** The Nebular theme to start with (used by NbThemeModule.forRoot, so the first paint is already right). */
export function initialThemeName(): string {
  const mode = storedThemeMode();
  return mode === 'dark' || (mode === 'system' && systemPrefersDark()) ? THEME_DARK : THEME_LIGHT;
}

/**
 * Light / dark / system. "system" follows the device setting (and changes with it); the choice is kept in this browser
 * (localStorage), default light.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  mode: ThemeMode = storedThemeMode();
  private media?: MediaQueryList;

  constructor(private nbTheme: NbThemeService) {
    try {
      this.media = window.matchMedia('(prefers-color-scheme: dark)');
      this.media.addEventListener('change', () => { if (this.mode === 'system') this.apply(); });
    } catch { /* no matchMedia */ }
    this.apply();
  }

  set(mode: ThemeMode) {
    this.mode = mode;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* not kept */ }
    this.apply();
  }

  /** What is shown now: dark or light (for "system" it depends on the device). */
  get effective(): 'light' | 'dark' {
    return this.mode === 'dark' || (this.mode === 'system' && !!this.media?.matches) ? 'dark' : 'light';
  }

  private apply() {
    const dark = this.effective === 'dark';
    this.nbTheme.changeTheme(dark ? THEME_DARK : THEME_LIGHT);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; // native controls, scrollbars
    document.documentElement.style.background = dark ? '#151a30' : '';
  }
}
