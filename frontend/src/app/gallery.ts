/**
 * Consecutive image embeds (separated only by whitespace / new lines) are shown as one gallery.
 * Messages keep the plain image embeds, so the bridge API, search, link previews and media cleanup
 * need no changes, and older messages with several images in a row become galleries too.
 */
const imageRun = /(?:\[image-embedded#\]\([^)\s|]+\)[ \t]*(?:\r?\n[ \t]*)*){2,}/g;
const imageUrl = /\[image-embedded#\]\(([^)\s|]+)\)/g;

const anyEmbed = /\[(image|video|audio|gallery)-embedded#\]\(([^)]*)\)/g;

/**
 * Readers who are not logged in get the texts but no files: every image, video, audio or gallery embed becomes a "locked" box of the same
 * proportions (the browser never asks for the file; the server refuses it anyway). Kept in the text, so it re-renders when the login state changes.
 */
export function lockEmbeds(text: string): string {
  return text.replace(anyEmbed, (_all, kind: string, url: string) => {
    const d = kind === 'gallery' ? null : /[?&]w=(\d{1,5})&h=(\d{1,5})/.exec(url); // the size the server put in the address (see media-dims.ts)
    return `[locked-embedded#](${kind}|${d ? d[1] : ''}|${d ? d[2] : ''})`;
  });
}

export function groupImageEmbeds(text: string): string {
  return text.replace(imageRun, (run) => {
    const urls = [...run.matchAll(imageUrl)].map(m => m[1]);
    return `[gallery-embedded#](${urls.join('|')})` + (/\n\s*$/.test(run) ? '\n' : '');
  });
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function renderGallery(urls: string[]): string {
  const n = urls.length;
  const cells = urls.map((u, i) =>
    `<div class="gallery-cell${i >= 4 ? ' gallery-hidden' : ''}"><img src="${attr(u)}" class="gallery-img" alt="תמונה ${i + 1} מתוך ${n}" loading="lazy">` +
    (i === 3 && n > 4 ? `<span class="gallery-more" aria-hidden="true">+${n - 4}</span>` : '') + `</div>`).join('');
  return `<div class="msg-gallery g-${Math.min(n, 4)}" role="group" aria-label="גלריה של ${n} תמונות">${cells}</div>`;
}
