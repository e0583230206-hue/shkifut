// Unit tests for frontend/src/app/gallery.ts (Node 24 runs the TypeScript directly).
//   node --test tests/unit/gallery.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupImageEmbeds, renderGallery } from '../../frontend/src/app/gallery.ts';

const img = (n) => `[image-embedded#](/api/files/${String(n).padStart(40, '0')}.jpg)`;

test('two or more consecutive images become one gallery, in order', () => {
  const out = groupImageEmbeds(`כותרת\n${img(1)}\n${img(2)}\n${img(3)}\nסוף`);
  assert.equal(out, `כותרת\n[gallery-embedded#](/api/files/${'0'.repeat(39)}1.jpg|/api/files/${'0'.repeat(39)}2.jpg|/api/files/${'0'.repeat(39)}3.jpg)\nסוף`);
});

test('a single image stays a single image', () => {
  const text = `טקסט\n${img(1)}\nעוד טקסט`;
  assert.equal(groupImageEmbeds(text), text);
});

test('images separated by text are not grouped', () => {
  const text = `${img(1)}\nבאמצע\n${img(2)}`;
  assert.equal(groupImageEmbeds(text), text);
});

test('blank lines between images still form a gallery; videos are left alone', () => {
  const out = groupImageEmbeds(`${img(1)}\n\n${img(2)}\n[video-embedded#](/api/files/v.mp4)`);
  assert.match(out, /^\[gallery-embedded#\]\([^)]*\|[^)]*\)\n\[video-embedded#\]/);
});

test('render: 4 visible cells, the rest hidden, "+N" on the 4th', () => {
  const html = renderGallery(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal((html.match(/<img /g) || []).length, 6);
  assert.equal((html.match(/gallery-hidden/g) || []).length, 2);
  assert.match(html, /gallery-more[^>]*>\+2</);
  assert.match(html, /class="msg-gallery g-4"/);
  assert.match(html, /alt="תמונה 1 מתוך 6"/);
});

test('render: attribute values are escaped', () => {
  const html = renderGallery(['/x" onerror="alert(1)', 'b']);
  assert.ok(!html.includes('" onerror="'));
  assert.ok(html.includes('&quot; onerror=&quot;'));
});

// ---- lockEmbeds: visitors who are not logged in get the texts but no files
import { lockEmbeds } from '../../frontend/src/app/gallery.ts';

test('lock: every file embed becomes a locked box of the same proportions, the text stays', () => {
  const out = lockEmbeds('שלום\n[image-embedded#](/api/files/a.jpg?w=848&h=480)\n[video-embedded#](/api/files/b.mp4?w=478&h=850)\n[audio-embedded#](/api/files/c.ogg)\nסוף');
  assert.equal(out, 'שלום\n[locked-embedded#](image|848|480)\n[locked-embedded#](video|478|850)\n[locked-embedded#](audio||)\nסוף');
  assert.ok(!out.includes('/api/files/'), 'the address of no file is left in the text');
});

test('lock: an old message without a size, a gallery and quotes', () => {
  assert.equal(lockEmbeds('[image-embedded#](/api/files/a.jpg)'), '[locked-embedded#](image||)');
  assert.equal(lockEmbeds('[gallery-embedded#](/api/files/a.jpg?w=1&h=1|/api/files/b.jpg)'), '[locked-embedded#](gallery||)');
  assert.equal(lockEmbeds('[quote-embedded#](12@תמונה 📷)'), '[quote-embedded#](12@תמונה 📷)');
});

test('lock: grouping first, so a row of images becomes ONE locked box', () => {
  const out = lockEmbeds(groupImageEmbeds(`${img(1)}\n${img(2)}\n${img(3)}`));
  assert.equal(out, '[locked-embedded#](gallery||)');
});
