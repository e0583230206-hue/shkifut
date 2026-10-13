# Brand assets (logo "שקיפות")

- `source/logo-main.png` - copy of the chosen main logo (the original in Downloads is untouched).
- `make_brand.py` - builds everything in `out/` (needs Pillow): `py -3 brand/make_brand.py`.
- `make_preview.py` - writes `preview.html`, a mock-up of every place the logo appears.

Not wired into the site yet. To use (after approval): copy `out/favicon.ico` and the icons to `frontend/src/assets/`,
add the `<link rel="icon">`/`apple-touch-icon` tags to `frontend/src/index.html`, set the channel logo (admin settings) to
`logo-symbol.png` or `logo-header@2x.png`, and point `og:image` (backend/seo.go) at `og-image.png`.
`logo-transparent.png` is an option only: its black parts disappear on dark backgrounds.
