# Verity website

The source for the Verity landing page, live at **https://verityresearch.us**.

## Edit it

```bash
cd site
npm install
npm run dev      # local preview at the address it prints, usually http://localhost:5173
npm run build    # checks that it builds; writes dist/index.html
```

| What you want to change | File |
| --- | --- |
| Text, numbers, sections | `src/App.tsx` (the data lists at the top hold most of the content) |
| Layout and styling | `src/site.css` |
| Colours, fonts, spacing | `src/tokens.css` |
| The 3D coin | `src/Coin3D.tsx` |
| The ledger page | `src/Portal.tsx`, opened at `#ledger` |

Make changes on a branch and open a pull request, like the rest of this repo.

## Publishing

The live site is published from a separate repo, `ryanmarklin-arch/verityresearch-site`, whose GitHub Action rebuilds verityresearch.us on every push to its `main`. This folder is the team's copy of the same source. To publish a change, copy the changed files into that repo (or ask Ryan to), and push.

## Rules for content

- Every number on the page comes from the real Nov 18, 2026 analysis. Don't add made-up metrics, quotes or logos.
- "Gemini" means Gemini Exchange, the prediction-market exchange, never Google Gemini.
- Write in sentence case with proper capitals (NYC, NWS, USDC).
- Keep motion behind `prefers-reduced-motion` checks, as the existing code does.
- Never commit API keys or other secrets.

`CLAUDE.md` has the full project notes.
