# Verity design system: institutional prediction terminal

Status: approved by the owner on 2026-11-19 (slate and blue palette, single-file vanilla build, Astryx tokens). This replaces the black-and-gold certificate and Lovable designs for verityresearch.us. The earlier designs stay in git history.

## 1. Direction

A dense financial exchange interface combined with a restrained cryptographic dashboard. It should feel quantitative, precise and high-trust. Every interactive element does something real. Anything simulated says so on the element itself.

## 2. Colour tokens

| Token | Value | Use |
| --- | --- | --- |
| `--bg-void` | `#090C10` | Page background |
| `--bg-surface` | `#10151E` | Panels |
| `--bg-elevated` | `#161D29` | Inputs, hovered rows, drawers |
| `--border-hairline` | `#1E2738` | All structure (1px) |
| `--border-strong` | `#2A3550` | Derived: focus-adjacent borders, chart gridlines that must read at 3:1 |
| `--accent-blue` | `#2E5CFF` | Primary actions, market price, protocol interaction |
| `--accent-blue-text` | `#7C9BFF` | Derived: blue used as text on dark surfaces (4.5:1 or better) |
| `--signal-yes` | `#00C853` | Affirmative outcomes, verified |
| `--signal-no` | `#FF3B30` | Negative outcomes, rejection, discrepancy, high risk |
| `--signal-no-text` | `#FF6B62` | Derived: red text on dark (4.5:1) |
| `--signal-warn` | `#F59E0B` | Pending approval, warnings, incomplete evidence |
| `--text-primary` | `#F1F5F9` | Body and headings |
| `--text-muted` | `#8B9BB4` | Secondary text (6.4:1 on void) |

Rules:
- YES/NO colours are market conventions. A YES price is not a verification state.
- Status is never colour alone. Every tag carries a word and a glyph (✓, ✕, !, …).
- No purple, pink, neon gradients, glass blobs or decorative glows.

## 3. Typography

- Display and body: **Space Grotesk** 400/500/600/700.
- Technical: **JetBrains Mono** 400/500 for prices, probabilities, hashes, identifiers, nonces, timestamps, axes, code and metrics.
- Every number that updates uses `font-variant-numeric: tabular-nums`.
- Forbidden: Inter, Roboto, Arial. Fallbacks are `ui-sans-serif, system-ui` and `ui-monospace, monospace`.

| Role | Size / line height | Weight | Tracking |
| --- | --- | --- | --- |
| Display (hero) | clamp(2.25rem, 5.2vw, 4.5rem) / 1.02 | 600 | -0.03em |
| H2 (section) | clamp(1.6rem, 2.8vw, 2.4rem) / 1.1 | 600 | -0.02em |
| H3 (panel) | 1.05rem / 1.3 | 600 | -0.01em |
| Body | 1rem / 1.55 | 400 | 0 |
| Small | 0.875rem / 1.5 | 400 | 0 |
| Technical label | 0.72rem / 1.4, mono | 500 | 0.04em |
| Data | 0.8125rem / 1.4, mono, tabular | 400 | 0 |

Text is in sentence case with proper capitals (NYC, NWS, USDC, Gemini Exchange). Body lines stay under about 72 characters.

## 4. Layout

- Desktop: a 12-column grid, max width 1440px, 32px outer margin, 24px gutter.
- Tablet (≤1024px): 8 columns, 24px margin.
- Mobile (≤640px): 4 columns, 16px margin. The minimum supported width is 360px.
- Hierarchy comes from 1px hairlines and surface steps. There are no drop shadows.
- Sections alternate their rhythm: a split hero, an asymmetric 8+4 terminal, a full-width state machine, a matrix table, then a dense ledger.

## 5. Spacing, radius and motion (from Astryx `@astryxdesign/core` tokens)

- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96 px.
- Radius: `--radius-inner` 4px (tags, inputs), `--radius-element` 8px (buttons, panels). Tables and ledgers use 0.
- Focus: a 2px solid ring in `--accent-blue-text` with a 3px offset (Astryx focus tokens), on `:focus-visible` only.
- Duration: `--duration-fast` 175ms for hover and state, `--duration-medium` 410ms for panel changes, `--duration-slow` 975ms for the one hero entrance.
- Easing: `--ease-standard` cubic-bezier(0.24, 1, 0.4, 1) for arrivals, `--ease-exit` cubic-bezier(0.3, 0, 0.6, 0.6) for departures.
- Hover transitions run at about 150ms.
- Motion gives feedback. It is not decoration. `prefers-reduced-motion` stops the ticker, the coin's idle spin, the candle stream and all transitions.

## 6. Component states

Every control defines default, hover, focus-visible, active, selected (`aria-pressed`/`aria-selected`), loading (`aria-busy`), success, error and disabled. Disabled controls drop to 45% opacity and are never the only way to learn why.

## 7. Charts

- Canvas 2D at device pixel ratio, resized with ResizeObserver, paused offscreen with IntersectionObserver.
- Gridlines use `--border-hairline`. Axes are mono 11px muted. The price line is `--accent-blue`.
- Resolution risk is never drawn on the probability axis. It has its own 4–12 scale gauge.
- Every chart has a crosshair, a tooltip, touch scrubbing and a table alternative in a `<details>`.
- Historical price paths are labelled DEMO FIXTURE, because only single snapshots were captured.

## 8. Data integrity

- Real data: the five Gemini Exchange fixture markets (captured 2026-11-17), the live OKC read and the NYC analysis (2026-11-18), the merchant catalog `verity-catalog-v1` and the spending tiers.
- Simulated data: price history, candles, depth beyond top of book, payment, settlement and stream events, and ledger rows. Each is labelled DEMO FIXTURE where shown.
- Hashes on the page are computed in the browser (keccak-256 and SHA-256) from the fixture shown. Transaction references are `demo-tx-…` identifiers, never hex that looks like a real chain hash.
- No demo control can reach a wallet, signer or network payment endpoint.
