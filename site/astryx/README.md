# Front-page market pop-up (Astryx)

Clicking a dot in the front-page constellation opens this dialog. It is built with Meta's Astryx
design system (`@astryxdesign/core`: Dialog, DialogHeader, Badge, Button, Text, Heading, Stack, Divider, StatusDot)
and React 19, bundled into one script that the page loads only on the first click.

- `dot-dialog.jsx` – the component. Exposes `window.VerityDotDialog.open(market)`.
- `build.sh` – `sh build.sh` writes `out/verity-dot.js` and `out/astryx.css`.
- Publish: copy both files, plus `out/index.html` (a redirect to the home page, so `/astryx/` is not a 404), to `astryx/` in `ryanmarklin-arch/verityresearch-live`, then bump the `?v=` keys
  in `site/src/body.html` (search for `/astryx/`) and rebuild the site.

Astryx stays inside the pop-up: the tree is marked as a nested theme, so Astryx never writes
`data-theme` / `data-astryx-theme` on `<html>`, and its CSS is class-scoped.
All values shown come from the public Gemini Exchange API response the front page already fetched.
