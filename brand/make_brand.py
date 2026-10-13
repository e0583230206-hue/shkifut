"""Builds the brand assets from brand/source/logo-main.png (the original is never modified).
    py -3 brand/make_brand.py
Outputs go to brand/out/. Nothing here is wired into the site; see brand/README.md."""
import os
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'source', 'logo-main.png')
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
WHITE = (255, 255, 255)


def save_png(im, name, quantize=None):
    path = os.path.join(OUT, name)
    if quantize:
        im = im.convert('RGB').quantize(quantize, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    im.save(path, optimize=True)
    return path


def ink_mask(rgb, thr=24):
    diff = ImageChops.difference(rgb, Image.new('RGB', rgb.size, WHITE)).convert('L')
    return diff.point(lambda v: 255 if v > thr else 0)


def on_white(im_rgba):
    bg = Image.new('RGB', im_rgba.size, WHITE)
    bg.paste(im_rgba, mask=im_rgba.getchannel('A'))
    return bg


# 4. transparent version: remove only the background that touches the border; keep inner whites; un-mix edge pixels
src = Image.open(SRC).convert('RGB')
w, h = src.size
px = src.load()
near_white = src.convert('L').point(lambda v: 255 if v >= 244 else 0)          # candidates
bgm = near_white.copy()
for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
    if bgm.getpixel(corner) == 255:
        ImageDraw.floodfill(bgm, corner, 128)
is_bg = bgm.point(lambda v: 255 if v == 128 else 0)
band = is_bg
for _ in range(3):
    band = band.filter(ImageFilter.MaxFilter(3))
bp, bgp, nwp = band.load(), is_bg.load(), near_white.load()
rgba = Image.new('RGBA', (w, h))
op = rgba.load()
ink = {}
for y in range(h):
    for x in range(w):
        if bgp[x, y]:
            op[x, y] = (0, 0, 0, 0)
        elif bp[x, y]:
            ink[(x, y)] = None                       # edge band: colour decided below
        else:
            r, g, b = px[x, y]
            op[x, y] = (r, g, b, 255)
# edge pixels: the true ink colour is that of the nearest solid pixel; alpha = share of ink in the pixel
todo = set(ink)
for _ in range(4):
    resolved = {}
    for (x, y) in todo:
        cols = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in todo and not bgp[nx, ny]:
                    cols.append(op[nx, ny][:3])
        if cols:
            resolved[(x, y)] = tuple(sum(c[i] for c in cols) // len(cols) for i in range(3))
    for k, v in resolved.items():
        ink[k] = v
        todo.discard(k)
        r, g, b = px[k]
        ir, ig, ib = v
        dr, dg, db = 255 - ir, 255 - ig, 255 - ib
        den = dr * dr + dg * dg + db * db
        a = 1.0 if den == 0 else max(0.0, min(1.0, ((255 - r) * dr + (255 - g) * dg + (255 - b) * db) / den))
        op[k] = (ir, ig, ib, round(a * 255))
for (x, y) in todo:                                   # unresolved leftovers: keep as they were
    r, g, b = px[x, y]
    op[x, y] = (r, g, b, 255)
rgba_full = rgba
clean = on_white(rgba_full)                         # same pixels, but a true #FFFFFF background (the source is #FEFEFE)
mask = ink_mask(clean)
x0, y0, x1, y1 = mask.getbbox()
PAD = 24
box = (x0 - PAD, y0 - PAD, x1 + PAD + 1, y1 + PAD + 1)
word = clean.crop(box)                              # wordmark with a white margin
rgba = rgba_full.crop(box)
print('wordmark', word.size)
# 1. header logo: 1x/2x/3x of a 48px-high wordmark
ratio = word.width / word.height
for scale in (1, 2, 3):
    h = 48 * scale
    im = word.resize((round(h * ratio), h), Image.LANCZOS)
    save_png(im, f'logo-header@{scale}x.png', quantize=64)

# 2. symbol only (magnifier): the connected ink pieces of ring + red centre + handle, without the red bars
m = mask.copy()                                       # coordinates below are in the full-size source
seeds = [(110, 527), (224, 527), (400, 790)]          # ring, red centre, handle (full-size source coordinates)
for s in seeds:
    if m.getpixel(s) == 255:
        ImageDraw.floodfill(m, s, 128)
sym_mask = m.point(lambda v: 255 if v == 128 else 0)
sb = sym_mask.getbbox()
print('symbol bbox', sb)
assert sb and (sb[2] - sb[0]) < 600, 'symbol segmentation leaked into the text/bars'
grow = sym_mask.filter(ImageFilter.MaxFilter(5))
sym = Image.new('RGB', clean.size, WHITE)
sym.paste(clean, mask=grow)
sym = sym.crop(sb)
side = max(sym.size)


def tile(size, fill_ratio, bg=WHITE):
    canvas = Image.new('RGB', (size, size), bg)
    inner = round(size * fill_ratio)
    s = sym.resize((round(sym.width * inner / side), round(sym.height * inner / side)), Image.LANCZOS)
    canvas.paste(s, ((size - s.width) // 2, (size - s.height) // 2))
    return canvas


for size in (16, 32, 180, 192, 512):
    save_png(tile(size, 0.92 if size <= 32 else 0.80), f'icon-{size}.png')
save_png(tile(512, 0.56), 'icon-maskable-512.png')           # inside the 80% safe circle of Android adaptive icons
ico_src = tile(256, 0.92)
ico_src.save(os.path.join(OUT, 'favicon.ico'), format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
save_png(tile(512, 0.86), 'logo-symbol.png')   # square symbol for the round avatar in the header

# 3. share image 1200x630, white, logo centred (600px wide so a square 630x630 centre crop keeps it whole)
og = Image.new('RGB', (1200, 630), WHITE)
lw = 600
lg = word.resize((lw, round(lw / ratio)), Image.LANCZOS)
og.paste(lg, ((1200 - lw) // 2, (630 - lg.height) // 2))
og.save(os.path.join(OUT, 'og-image.png'), optimize=True)

rgba.save(os.path.join(OUT, 'logo-transparent.png'), optimize=True)
w, h = rgba.size
dark = Image.new('RGB', (w, h), (30, 30, 36)); dark.paste(rgba, mask=rgba.getchannel('A'))
dark.save(os.path.join(OUT, '_check-dark.png'))
on_white(rgba).save(os.path.join(OUT, '_check-white.png'))
print('done:', sorted(os.listdir(OUT)))
