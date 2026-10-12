/**
 * Consecutive image embeds (separated only by whitespace / new lines) are shown as one gallery.
 * Messages keep the plain image embeds, so the bridge API, search, link previews and media cleanup
 * need no changes, and older messages with several images in a row become galleries too.
 */
const imageRun = /(?:\[image-embedded#\]\([^)\s|]+\)[ \t]*(?:\r?\n[ \t]*)*){2,}/g;
const imageUrl = /\[image-embedded#\]\(([^)\s|]+)\)/g;

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
