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
