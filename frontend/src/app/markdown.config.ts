import { Token, Tokens, TokensList } from "marked";
import { MarkdownModuleConfig, MARKED_EXTENSIONS, MARKED_OPTIONS, MarkedRenderer } from "ngx-markdown";
import { renderGallery } from "./gallery";
import { boxRatio, dimsFromUrl } from "./media-dims";

const matchCustomEmbedRegEx = /^\[(video|audio|image|quote|gallery|locked)-embedded#]\((.*?)\)/;

//https://regexr.com/3dj5t
const matchYoutubeRegEx = /^((?:https?:)?\/\/)?((?:www|m)\.)?((?:youtube\.com|youtu.be))(\/(?:[\w\-]+\?v=|embed\/|v\/)?)(?<id>[\w\-]+)(\S+)?$/;

const customEmbedExtension = {
  extensions: [{
    name: 'custom_embed',
    level: 'inline',
    start: (src: string) => src.match(matchCustomEmbedRegEx)?.index ?? src.match(matchYoutubeRegEx)?.index,
    tokenizer: (src: string, tokens: Token[] | TokensList) => {

      let match = src.match(matchCustomEmbedRegEx);
      if (match) {
        switch (match[1]) {
          case 'quote':
            const s = match[2].split(/@(.*)/);
            return {
              type: 'custom_embed',
              raw: match[0],
              meta: { type: 'quote', id: s[0], url: s[1] },
            };

          default:
            return {
              type: 'custom_embed',
              raw: match[0],
              meta: { type: match[1], url: match[2] },
            };
        }

      }

      match = src.match(matchYoutubeRegEx);
      if (match && match.groups?.['id']) {
        return {
          type: 'custom_embed',
          raw: match[0],
          meta: { type: 'youtube', id: match.groups['id'] },
        };
      }

      return undefined;
    },
    renderer: (token: Tokens.Generic) => {
      const { type, url, id } = token['meta'];
      switch (type) {
        case 'video': {
          const box = boxRatio(dimsFromUrl(String(url)), 'video');
          return `<div class="msg-media"><video controls preload="metadata" aria-label="וידאו" style="aspect-ratio: ${box.css}"><source src="${url}" type="video/mp4"></video></div>`;
        }
        case 'audio':
          return `<div><audio src="${url}" controls preload="metadata" aria-label="קטע שמע"></audio></div>`;
        case 'image': {
          const box = boxRatio(dimsFromUrl(String(url)), 'image');
          return `<div class="msg-media"><img src="${url}" class="img-fluid" alt="תמונה" loading="lazy" style="aspect-ratio: ${box.css}"></div>`;
        }
        case 'locked': {
          const [kind, w, h] = String(url).split('|');
          const box = boxRatio(+w > 0 && +h > 0 ? { w: +w, h: +h } : null, kind === 'video' ? 'video' : 'image');
          return `<div class="mod-locked${kind === 'audio' ? ' mod-locked-audio' : ''}" role="button" tabindex="0"${kind === 'audio' ? '' : ` style="aspect-ratio: ${box.css}"`}><div><div>יש להתחבר כדי לצפות בקבצים</div><a class="mod-locked-link">לחצו כאן להתחברות</a></div></div>`;
        }
        case 'youtube':
          return `<div class="msg-media" style="position: relative;"><img youtubeid="${id}" src="https://ytimg.googleusercontent.com/vi/${id}/hqdefault.jpg" class="img-fluid" style="width: 100%; aspect-ratio: 4 / 3; object-fit: cover;"><i
          class="bi bi-youtube" youtubeid="${id}" style="position: absolute; place-self: anchor-center; color: red; font-size: 70px;"></i></div>`;
        case 'quote':
          return `<blockquote class="quote" quote-id="${id}"><p>${url}</p></blockquote>`;
        case 'gallery':
          return renderGallery(String(url).split('|').filter(Boolean));
        default:
          return '';
      }
    }
  }]
}

const renderer = new MarkedRenderer();

//https://github.com/jfcere/ngx-markdown/issues/79#issuecomment-2484682034
renderer.link = ({ href, text }) => {
  return `<a target="_blank" href="${href}">${text}</a>`;
}
//renderer.paragraph = ({ tokens }) => Parser.parseInline(tokens);

export const MarkdownConfig: MarkdownModuleConfig = {
  markedExtensions: [
    {
      provide: MARKED_EXTENSIONS,
      useValue: customEmbedExtension,
      multi: true,
    },
  ],
  markedOptions: {
    provide: MARKED_OPTIONS,
    useValue: {
      renderer: renderer,
      breaks: true,
    },
  }
}