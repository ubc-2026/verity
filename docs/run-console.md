# Run console: market, agent run, results, audit

The run console connects the Issue #8 workflow on one page: pick a Gemini Exchange market, run Verity's analysis, step through an evidence purchase, and audit the run against its purchase, receipt and payment evidence.

```bash
npm ci
npm run app          # http://127.0.0.1:8790/  (console at /, API under /api)
```

The server prints an operator token for the session (or reads `VERITY_OPERATOR_TOKEN`). Visitors can start runs and read results. Payment steps need the operator token. Set `VERITY_PYTHON` if `analysis/.venv` is missing.

The page follows the website's design system (`site/DESIGN.md` on the `website` branch): Space Grotesk and JetBrains Mono, the slate and blue tokens, and status tags that always carry a word and a glyph. It is one file, `ui/index.html`, with no build step, so it can be ported into the terminal site.

## What is live and what is fixture

| Part | Mode |
| --- | --- |
| Live market list | LIVE read-only: `GET https://api.gemini.com/v1/prediction-markets/events?status=active` |
| Live analysis run | LIVE read-only: `analyze-live` reads `api.gemini.com`, `assets.gemini.com` and `forecast.weather.gov` only. No model, no payment. No evidence catalog is passed, so a live run never proposes a purchase. |
| Fixture markets and analysis | FIXTURE: five markets captured 2026-11-17 |
| Quote, policy, approval, signing, merchant, receipt | FIXTURE keys (public Anvil test keys), in-process merchant |
| Arc direct settlement | FIXTURE stub; the tx hash is derived and is not on Arc Testnet |
| Circle Gateway | FIXTURE mock (`scripts/e2e/mockGateway.ts`): verify, settle, per-transfer status, batch |
| QuickNode | FIXTURE deliveries, signed locally and run through the real stream filter, HMAC check, replay window and finality rule |

## Results view

- Market card: question, outcome, source link, read time, and expiry.
- **Market-implied price**: the mid of the best bid and ask, only for a two-sided, uncrossed, fresh book. Missing, one-sided, crossed, stale and closed books show no price and say why. A live quote older than 300 s is stale.
- **Model estimate**: shown separately and marked unavailable. The analysis rates how a contract settles, not who wins, so it produces no outcome probability.
- Settlement-risk rating with each factor's score, rationale and citation IDs, evidence gaps, the buy or abstain decision, the free-source check log, and every citation with its source URL.
- Values the analysis does not carry are listed as unavailable, never filled in.

## Purchase steps

| Rail | Steps |
| --- | --- |
| Both | quote, policy decision, approve or reject (direct rail owner tier only), advance the fixture clock, pay, retry (reuses the stored authorization), verify receipt and bytes, overdue check, reassess |
| Circle Gateway | ask Circle for the transfer (by nonce, payer and payee), advance the fixture batch, replay an older Circle response |
| QuickNode | event, replay, forged signature, stale timestamp. On Arc direct the event is the purchase's own transaction. On Gateway it is the batch transaction Circle reported. |

Scenarios: standard, free source answers, owner approval (Arc direct), budget denial, receipt rejection, and lost Gateway response (Gateway: Circle settles but the answer never reaches the merchant).

## Audit view

`GET /api/audit` and each run's `audit` field use one record per run:

| Field | Source |
| --- | --- |
| `runId`, `purchaseId` | the run, and the purchase ID it reserved |
| `quote` | quote ID, amount, expiry, and `fresh` or `expired` against the fixture clock |
| `authorization` | status, request hash, nonce, payer, payee from the durable buyer store |
| `receipt` | verified V1 or V2 receipt: digest, signer, content hash; or the rejection code |
| `payment.circleTransfer` (Gateway) | Circle's transfer ID and status. Circle identifies the individual payment. `receiptNamesSameTransfer` checks the signed receipt against it. |
| `payment.arcBatch` (Gateway) | the batch transaction Circle reported for that transfer |
| `payment.quicknode.batch` (Gateway) | QuickNode's confirmation that the batch transaction succeeded in a finalized block. Batch level only. |
| `payment.quicknode.perTransfer` (Gateway) | always `not_claimed`: the batch log names neither payer nor seller |
| `payment.transaction`, `payment.quicknode` (Arc direct) | the purchase's own transaction, matched by QuickNode on chain, token, payer and nonce |
| `reassessment` | runs only on bytes verified against the signed receipt for this purchase |
| `portal` (Gateway) | the body for `POST /purchases/{id}/gateway` on `verity-audit-portal` |

## Ordering, replay and restart rules

- Circle's transfer record and the verified receipt can arrive in either order. A transfer seen first must match the stored authorization (nonce, payer, payee, amount in base units). The later receipt must name that same transfer, or the ledger refuses it.
- Circle status only moves forward (received, batched, confirmed, completed; `failed` only before confirmation). A stale response never regresses a settled purchase, and the reservation is spent once.
- A lost settle response is recovered by nonce on the retry, with no second settlement and no second signature.
- Buyer and merchant state is SQLite, so a restart resumes from disk. `test/acceptance.test.ts` proves these rules with file-backed stores.
- The run console itself keeps each run in memory, with one in-memory payment store per run, so its runs and the operator pause switch are gone after a restart. `/api/config` says so in `ledger`. The durable path is the same `PaymentStore` and `MerchantService` opened on a file, as the acceptance tests do.
- At most 2 uncached live analyses run at once; a third gets 429. Visitors may start 30 runs a minute in total.
