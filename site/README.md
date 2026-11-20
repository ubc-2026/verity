# Verity website (`site/`)

The public site at https://verityresearch.us: one self-contained HTML file (vanilla HTML, CSS and JavaScript). It has no framework and no build dependencies beyond `sh`.

- `src/style.css`, `src/body.html`, `src/app1.js` to `app3.js`: the source parts.
- `keccak.js`: the keccak-256 used for request hashes (checked against reference vectors).
- `build.sh`: concatenates everything into `dist/index.html`.
- `DESIGN.md`: the approved design system (institutional prediction terminal).

## Edit and publish

1. Edit the files in `src/`, then run `sh build.sh`.
2. Open `dist/index.html` in a browser to check it.
3. Copy `dist/index.html` to `index.html` in the public repo `ryanmarklin-arch/verityresearch-live`, keeping `CNAME` and `.nojekyll`, and push to `main`. GitHub Pages serves it on verityresearch.us.

## Data rules

- Quotes and scores come only from the Nov 17 and 18, 2026 Gemini Exchange captures and analysis. Gemini means Gemini Exchange, never Google Gemini.
- Price history, candles, payment, settlement and stream events are demo fixtures, labelled DEMO FIXTURE or SIMULATED on the page.
- No control on the page can reach a wallet, signer or payment endpoint.
