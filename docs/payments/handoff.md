# Payments handoff: Gateway nanopayment example and live research

This page gives the team one concrete purchase to integrate against, and the current result of live free research. It makes no new payment. Everything below comes from the archived 0.001 USDC Arc Testnet purchase of 2026-11-19, or from free public sources.

## The example purchase

Use `samples/handoff/gateway-purchase-example.json`. It is redacted (no salt, no receipt signature, and no keys) and tags every value with where it came from:

| Field | Value | Source |
| --- | --- | --- |
| `runId` | `arc-gateway-pay-2026-11-19T05:21:38Z` | DERIVED. The archived runner emitted none, so the format is still to be decided. |
| `purchaseId` | `purchase-live-6c672f194930d40dae57d10d` | Live run. Derived from the payer address and the FIXTURE proposal ID `prop-06680e4a9de9`. |
| `receiptDigest` | `0x28a8bbff5a9fe6d689b0e189077b1b9748f78bcef9872b853f459ad818bb693d` | Live run. DeliveryReceiptV2 signed by the live seller key over FIXTURE evidence bytes. |
| Circle transfer ID | `018a216c-72ff-454b-94b1-9bfbdf637f2d` | LIVE (Circle) |
| Arc batch tx | `0x3b31471543ae1a1bd08cdff377c57b9586c1c8ae7bd759703b5a1c3ebcaebd82` | LIVE (Arc Testnet, block 72968478) |

FIXTURE values: the contract `fx-nyc-high-20261118`, gap `GAP-NYC-SETTLE`, proposal `prop-06680e4a9de9`, the content hash (the evidence document is labelled FIXTURE), and the analysis before and after. The catalog item `cat-nws-cli-settlement-version-nano-v1` and merchant ID `verity-demo-merchant` are shared catalog entries that are approved only for that fixture market.

### Who proves what

- **Circle identifies the individual transfer.** The transfer record names payer, payee, amount (1000 base units), and the authorization nonce. `settle()` returned the same UUID, and the buyer stores it as `paymentRef` next to the receipt digest.
- **QuickNode confirms the Arc batch receipt.** It can show that the batch transaction succeeded and is final. It cannot show which transfer inside the batch is ours: the batch transaction has one log, emitted by GatewayWallet, and that log names neither the payer nor the seller. That is why the ledger keeps QuickNode at `not_claimed` for Gateway purchases.
- **QuickNode confirmation is not done yet.** It uses account credits and needs the owner's approval, and the QuickNode key returned 403 earlier. In the meantime, Arc's public RPC (`https://rpc.testnet.arc.io`, not QuickNode) shows the batch transaction `success` in block 72968478 at 05:27:02 UTC, 323 s after settle.

### Portal calls

The example's `portalCalls` block uses the shapes in `portal/README.md` on branch `verity-audit-portal`: `POST /purchases`, `POST /purchases/{id}/delivery`, and `POST /purchases/{id}/gateway` (`paymentRef`, `receiptDigest`, `batchStatus`, `batchTxHash`). Two fields are open: `deliveryDeadlineUtc` (the Gateway runner sets none) and `salt` (redacted, because the portal needs it only for the direct rail).

## Live research: one candidate market

Command (free public sources only: `api.gemini.com`, `assets.gemini.com`, `forecast.weather.gov`; no model, no payment):

```bash
cd analysis && python -m verity.cli analyze-live --event WXHIGH-NYC-2611210459 --outcome "66°F to 67°F"
```

Output is in `samples/live/analyze-live-WXHIGH-NYC-2611210459.json` (snapshot 2026-11-19T21:29:38Z).

| Question | Answer |
| --- | --- |
| Market | Gemini "Highest temperature in NYC on November 20, 2026?", outcome 66°F to 67°F (`GEMI-WXHIGH-NYC-2611210459-66TO67`); bid 0.47 / ask 0.51 at the snapshot |
| Do official sources answer the gap? | Partly. The Gemini weather terms PDF names the NWS Climatological Report for Central Park as the primary source. It does not say which issuance settles the market (preliminary, final, or a later correction). The NWS CLINYC page was read as well. |
| Gap that remains | `GAP-1`, `settlement_source_version`, material. Rating High. |
| Purchase proposed? | **No.** No allowlisted catalog item is approved for this exact live contract. |
| Can an approved merchant fill it? | **Not today.** `verity-demo-merchant` sells this gap type (`cat-nws-cli-settlement-version-nano-v1`, 0.001 USDC on Gateway), but only for the fixture market, and the bytes it serves are a FIXTURE document for 2026-11-18. Filling the gap needs two things: owner approval of an item for this exact contract ID (`--evidence-catalog`), and a real settlement-version document for CLINYC on 2026-11-20. |

The run followed the purchase rule: free research first, a material gap still open, and an approved catalog item for that exact contract. The third condition failed, so nothing was proposed.
