# Connected fixture workflow

One command runs a market from research to an updated risk assessment:

```bash
npm ci
python -m venv analysis/.venv
analysis/.venv/bin/pip install -r analysis/requirements.txt   # Windows: analysis\.venv\Scripts\pip
npm run e2e
```

The script finds Python in `VERITY_PYTHON`, then `analysis/.venv`, then `python3` and `python`. It needs Python 3.11 or later with pydantic. It writes `samples/e2e-workflow.json` and prints one line per scenario. Everything runs on 127.0.0.1. Settlement is stubbed. No key, wallet, chain, or third-party service is used.

## What runs

```text
market fixture (Gemini event, instrument, terms, snapshot time)
  -> analysis/verity/cli.py analyze
       research: normalized market, Exa coverage recent vs prior, price movement or why it is unavailable
       risk analysis: scores, citations, evidence gaps
       cached evidence and free official sources first
       one unsigned PurchaseProposalV1 (gap, catalog item, contract, evidence type, max spend) or a specific reason
  -> acceptPurchaseProposal            catalog allowlist, evidence type and parameter names must match the item
  -> POST /quotes (bearer session)     buyer-generated purchase ID; the merchant must echo it
  -> BuyerService.purchase             policy tiers, durable reservation and request record, sign from the record
  -> POST /evidence/... (bearer)       X-Verity-Binding + X-Verity-Payment
       MerchantService.deliver = deliverPaidRequest: verify binding, durable claim, settle once
       (FIXTURE stub), resume by tx hash, sign DeliveryReceiptV1 over the served bytes
  -> acceptDelivery                    pinned merchant key, request binding, keccak256 of the raw bytes
  -> QuickNode webhook                 FIXTURE delivery, HMAC-signed, through the real filter and handler
       ReconciliationLedger joins the transfer to the verified receipt -> Reconciled
  -> analysis/verity/cli.py reassess   SHA-256 of the bytes against the provenance, then the revised assessment
  -> overdue events + read-only feed   checked against a contract model of the Grok Bot routine
```

**Circle Gateway rail (opt-in):** `npm run e2e:nano` runs the same contract through a 0.001 USDC nanopayment with Gateway mocked. See [Circle Gateway nanopayments](payments/circle-gateway.md).

The transport is Verity's own (`X-Verity-Binding`, `X-Verity-Payment`, `X-Verity-Receipt`, a JSON `402` quote). It is not standard x402, and x402 interoperability has not been built or tested.

## Scenarios

| Scenario | Market and input | Result the checks require |
| --- | --- | --- |
| `positive_purchase_changes_assessment` | NYC high temperature, observed free check (inconclusive) | Gap `GAP-NYC-SETTLE` triggers a 0.05 USDC auto-approved purchase. Receipt verified, ledger `Reconciled`. Reassessment closes the gap and lowers Source from 2 to 1, so the total goes from 8 to 7. The rating stays Medium because ambiguity 2 and liquidity 3 are untouched. No overdue event, and a forged event for this purchase opens no card. |
| `no_material_gap` | OKC moneyline | No proposal: "no material resolution gap". Coverage is explicitly unavailable. |
| `evidence_available_free` | NYC, free check answers the gap (fixture assumption) | No proposal: "answered by the free check". |
| `budget_denial` | NYC, mission budget 0.04 USDC | Policy refuses ("mission budget exceeded"). Nothing is recorded, signed, or settled. |
| `tampered_delivery` | NYC, one response byte altered in transit | Buyer rejects with `content_mismatch`. The analyst never sees the bytes. Ledger shows `Paid, delivery missing`. |
| `retry_without_second_settlement` | NYC, first settlement times out after broadcast | Two same-tick copies both get `202`. The buyer retry reuses the stored authorization, and the merchant resumes by tx hash. Later copies replay the receipt. Settle is called once and resume once. |
| `overdue_delivery_alert` | NYC, isolated world, merchant artifact unavailable | Paid and confirmed with no delivery. No event before the deadline and one after it. One card, and an exact replay keeps one card. A wrong routine key gets `401`. The feed without its token gets `401`. |

Each scenario keeps payment, delivery, analysis, and ledger statuses separate in the report.

## Fixture versus live

| Part | In `npm run e2e` |
| --- | --- |
| Market data | FIXTURE workbook snapshot (2026-11-17). The NYC terms excerpts were read from the real terms PDF on 2026-11-18. |
| Free check | `observed-2026-11-18` is a real reading of the terms PDF and NWS CLINYC. `free-check-answers` is a labeled assumption. |
| Exa coverage | CAPTURED: real Exa results recorded once on 2026-11-18 through the Exa connector, not by the repository's client. |
| Merchant evidence | FIXTURE document served by the demo merchant. It is not an NWS or Gemini statement. |
| Settlement | FIXTURE stub. The tx hashes are derived from the nonce and are not real transactions. |
| QuickNode | FIXTURE delivery signed with a fixture token, through the real stream filter, webhook handler, and ledger. |
| Grok Bot | Contract model in `scripts/e2e/grokRoutineModel.ts`. The real routine was not called. |
| ElevenLabs | Explanation text only (`src/payments/explain.ts`). No audio. |

## Choices made while integrating

Two payment branches overlapped: the local tested stack (`feat/delivery-receipts`) and `cursor/demo-merchant-policy-ledger-b01e`. The integration keeps one implementation of each concern:

- **DeliveryReceiptV1.** Both branches defined `verity-delivery-receipt-v1` with different fields. The stack's version is kept because it signs the tx hash, merchant ID, and chain, which the QuickNode join needs. The Cursor version (no tx hash, signed before any settlement) was removed.
- **Settlement and replays.** The Cursor merchant never settled and rejected a resubmission as `nonce_replay`. The integrated merchant settles once through `deliverPaidRequest` and replays the stored receipt on retry. That is the retry behavior the workflow requires.
- **Ledger.** The in-memory `AuditLedger` was replaced by the durable `ReconciliationLedger`, which joins QuickNode transfers to verified receipts.
- **Kept from the Cursor branch:** the policy tiers and owner EIP-712 approval (`policy.ts`, now enforced durably by `PaymentStore`), proposal acceptance (`proposal.ts`), the catalog and fixture documents (`catalog.ts`), quote issuance with the buyer's purchase ID (`service.ts`), and the HTTP merchant (`server.ts`, now authenticated). Its demo scenarios are covered by `test/service.test.ts`, `test/policy.test.ts`, and the e2e.
- **Removed from the shipping path:** `handlePaidRequest`, which settled after verifying with no claim, and the analysis trading client `analysis/verity/exchange.py`.

## Not covered here

- No live Arc Testnet transfer was made for this integration. `scripts/arc-purchase.ts` now settles through `deliverPaidRequest`, but that version has not been run live.
- No live QuickNode stream, Grok Bot routine, Exa search by the repository's client, or ElevenLabs call.
- Fixture markets record no instrument symbol and a single price, so price movement is always `unavailable` in this run.
