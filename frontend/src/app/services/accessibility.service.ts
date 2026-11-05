import { Injectable } from '@angular/core';

/** The settings of the accessibility menu. `text` is a step of the text size (0 = as designed). */
export interface A11yState {
  text: number;
  contrast: boolean;
  invert: boolean;
  gray: boolean;
  links: boolean;
  headings: boolean;
  readable: boolean;
  spacing: boolean;
  noAnim: boolean;
  cursor: boolean;
}

export type A11yFlag = Exclude<keyof A11yState, 'text'>;

const STORAGE_KEY = 'tc-a11y';
/** Text size steps, in percent of the browser's size (the site is built in rem, so everything follows). */
export const TEXT_STEPS = [100, 112.5, 125, 150, 175];

const DEFAULTS: A11yState = { text: 0, contrast: false, invert: false, gray: false, links: false, headings: false, readable: false, spacing: false, noAnim: false, cursor: false };
const FLAGS: A11yFlag[] = ['contrast', 'invert', 'gray', 'links', 'headings', 'readable', 'spacing', 'noAnim', 'cursor'];

/**
 * The accessibility menu: the reader's choices (text size, contrast, grey scale, underlined links ...) are kept in this browser and put on the page as
 * classes on <html> (styles.scss) and as the font size / filter of <html>. The same choices are applied before the app starts (index.html).
 */
@Injectable({ providedIn: 'root' })
export class AccessibilityService {
  state: A11yState = { ...DEFAULTS };

  constructor() {
    this.state = this.load();
  }

  /** Applies the saved choices (called when the app starts). */
  init(): void {
    this.apply();
  }

  get changed(): boolean {
    return this.state.text !== 0 || FLAGS.some(f => this.state[f]);
  }

  get textPercent(): number {
    return TEXT_STEPS[this.state.text];
  }

  toggle(flag: A11yFlag): void {
    this.state = { ...this.state, [flag]: !this.state[flag] };
    // "high contrast" and "inverted colours" are two ways of the same thing: one at a time
    if (flag === 'contrast' && this.state.contrast) this.state.invert = false;
    if (flag === 'invert' && this.state.invert) this.state.contrast = false;
    this.save();
    this.apply();
  }

  changeText(delta: number): void {
    const next = Math.max(0, Math.min(TEXT_STEPS.length - 1, this.state.text + delta));
    if (next === this.state.text) return;
    this.state = { ...this.state, text: next };
    this.save();
    this.apply();
  }

  reset(): void {
    this.state = { ...DEFAULTS };
    this.save();
    this.apply();
  }

  private load(): A11yState {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        const s: A11yState = { ...DEFAULTS };
        for (const f of FLAGS) s[f] = raw[f] === true;
        const t = Number(raw.text);
        s.text = Number.isInteger(t) && t >= 0 && t < TEXT_STEPS.length ? t : 0;
        return s;
      }
    } catch { /* no storage, or an unreadable value: the defaults */ }
    return { ...DEFAULTS };
  }

  private save(): void {
    try {
      if (this.changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* not kept */ }
  }

  private apply(): void {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    for (const f of FLAGS) html.classList.toggle('a11y-' + f.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), this.state[f]);
    html.style.fontSize = this.state.text ? this.textPercent + '%' : '';
    const filters: string[] = [];
    if (this.state.contrast) filters.push('contrast(1.45)', 'saturate(1.15)');
    if (this.state.invert) filters.push('invert(1)', 'hue-rotate(180deg)');
    if (this.state.gray) filters.push('grayscale(1)');
    html.style.filter = filters.join(' ');
  }
}
