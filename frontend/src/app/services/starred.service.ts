import { Injectable } from '@angular/core';

/** A message the reader marked with a star: what is needed to show it in the list and to jump to it. */
export interface StarredMessage {
  id: number;
  /** when the message was written (ISO), for the list */
  time: string;
  /** the beginning of its text, without markup */
  snippet: string;
  /** when it was starred (ms) */
  at: number;
}

const STORAGE_KEY = 'tc-starred';
const MAX = 300;

/**
 * "Saved messages": the star on a message. They are kept in THIS browser (localStorage), they work without signing in, and nobody else sees them.
 * The list keeps a short copy of each message, so that it can be shown at once and also when the message is not loaded in the chat.
 */
@Injectable({ providedIn: 'root' })
export class StarredService {
  /** newest star first */
  items: StarredMessage[] = [];

  constructor() {
    this.items = this.load();
    // the same browser in another tab: the list follows
    try {
      window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY) this.items = this.load(); });
    } catch { /* no window */ }
  }

  get count(): number {
    return this.items.length;
  }

  has(id?: number): boolean {
    return !!id && this.items.some(s => s.id === id);
  }

  /** Stars the message, or takes the star away. Returns true when it is starred now. */
  toggle(message: { id?: number; text?: string; timestamp?: string | Date }): boolean {
    const id = message.id;
    if (!id) return false;
    if (this.has(id)) {
      this.remove(id);
      return false;
    }
    const time = message.timestamp ? new Date(message.timestamp).toISOString() : '';
    this.items = [{ id, time, snippet: snippetOf(message.text || ''), at: Date.now() }, ...this.items].slice(0, MAX);
    this.save();
    return true;
  }

  remove(id: number): void {
    this.items = this.items.filter(s => s.id !== id);
    this.save();
  }

  clear(): void {
    this.items = [];
    this.save();
  }

  private load(): StarredMessage[] {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(s => s && Number.isInteger(s.id) && s.id > 0)
        .map(s => ({ id: s.id, time: typeof s.time === 'string' ? s.time : '', snippet: typeof s.snippet === 'string' ? s.snippet.slice(0, 200) : '', at: Number(s.at) || 0 }))
        .slice(0, MAX);
    } catch {
      return []; // no storage, or an unreadable value
    }
  }

  private save(): void {
    try {
      if (this.items.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* not kept */ }
  }
}

/** The text of a message as one short line: no embeds, tags or markdown marks. */
export function snippetOf(text: string, max = 140): string {
  const t = text
    .replace(/\[[a-z]+-embedded#\]\([^)]*\)/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~>#|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t) return t.length > max ? t.slice(0, max - 1).trim() + '…' : t;
  return /\[(image|gallery)-embedded#\]/i.test(text) ? 'תמונה' : /\[video-embedded#\]/i.test(text) ? 'סרטון' : /\[audio-embedded#\]/i.test(text) ? 'הקלטה' : 'הודעה';
}
