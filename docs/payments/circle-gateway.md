# Circle Gateway nanopayments (opt-in rail)

Verity can buy one evidence item for **0.001 USDC** through Circle Gateway on Arc Testnet. The direct EIP-3009 rail is unchanged and remains the default.

```bash
npm run e2e:nano      # fixture loop, Gateway MOCKED; writes samples/e2e-nano.json
```

No Circle API call, Gateway deposit, or testnet payment is made by this command or by any test.

## Flow

```text
NYC high-temperature contract (fixture)
  quote rule 13.111(i)(2) (C-NYC-4) and gap GAP-NYC-SETTLE
  free sources first (terms PDF, NWS CLINYC) -> still open
  -> unsigned proposal: contract, gap, cat-nws-cli-settlement-version-nano-v1, ceiling 1000 base units
BuyerService.purchase
  assessPolicy: explicit nanopayment tier (rail circle-gateway-batched, allowlisted item, <= 0.001 USDC, material gap)
  PaymentStore.reserveAndRecord: reservation + request + nonce + rail, one transaction, stable purchase ID
  authorizeStoredPurchase: EIP-3009 signed under GatewayWalletBatched v1 (verifyingContract = Gateway Wallet)
POST /evidence/nws-cli-settlement-nano  (bearer session, X-Verity-Binding, X-Verity-Payment)
  MerchantService.deliver -> deliverGatewayPaidRequest
    verifyPaidRequest (trusted quote, request binding, Gateway-domain signature)
    durable claim (purchase + nonce)        -> Gateway verify() + settle() at most once
    lost or indeterminate settle stays claimed -> searchTransfers({ nonce, from, to })
    accepted -> Circle transfer by nonce    -> DeliveryReceiptV2 (purchaseId, transfer ID, nonce, content hash)
buyer: verifyGatewayDelivery (pinned key, binding, keccak256 of bytes, own nonce) -> GatewayLedger: accepted
later: Circle status moves only forward (received -> batched -> confirmed/completed); the batch row and the reservation spend commit together -> GatewayLedger: batch_settled
analyst: reassess with the verified bytes and provenance (payment_rail, payment_ref)
```

## What is recorded where

| Fact | Buyer (`GatewayLedger`, payment DB) | Merchant (`GatewayDeliveryStore`) |
| --- | --- | --- |
| Gateway accepted the payment | `accepted_at`, receipt digest, `payment_ref` | `status = accepted`, `settle_transaction` |
| Circle per-payment ID | `payment_ref` (UNIQUE), tied to `purchase_id` and the V2 receipt | `payment_ref` (UNIQUE) |
| Batch settlement | `batch_status`, `batch_tx_hash` (reservation becomes spend at `confirmed`/`completed`) | `batch_status`, `batch_tx_hash` |
| QuickNode | `not_claimed` | — |

QuickNode reconciliation is **not claimed** for Gateway purchases. Gateway settles many payments in one batch transaction, and Circle does not document how to attribute one transfer inside it, so an onchain log cannot prove this purchase's match. The direct rail keeps its proven per-purchase QuickNode join.

## Policy and safeguards kept

- **Explicit policy:** `NANOPAYMENT_POLICY` in `src/payments/policy.ts`, enforced again by `PaymentStore`. Only `cat-nws-cli-settlement-version-nano-v1`, 1 to 1000 base units, material gap required, mission budget applies. 0.001 USDC on the direct rail is still refused (0.01 USDC minimum).
- **Trusted quote, request binding, stable purchase ID, duplicate protection:** unchanged code paths (`buildResearchRequest`, the nonce commitment, `verifyPaidRequest`, one purchase per mission + contract + evidence type).
- **Duplicate charge:** the merchant's durable claim lets only one request call Gateway `settle()`; a retry replays the stored V2 receipt. A deterministic settle rejection (Circle's documented HTTP 200 `errorReason` values other than `nonce_already_used`) releases the claim. A lost response, HTTP 500 `unexpected_error`, or `nonce_already_used` keeps the claim. The retry reconciles that claim by the original EIP-3009 nonce (`searchTransfers({ nonce, from, to })`), checks that the transfer carries that nonce, the payer, the recipient, the amount, and a non-failed status, then resumes receipt issuance. The claim is never submitted a second time.
- **Forward-only batch status:** buyer `recordBatch` ignores a pending or failed response once the transfer is `confirmed` or `completed`. The batch row and the reservation spend (`confirmed` / `completed`) commit in one SQLite transaction.
- **One deliberate relaxation:** Circle requires Gateway authorizations to be valid for at least 7 days (`GATEWAY_MIN_AUTH_VALIDITY_SECONDS` in the SDK). On this rail only, `validBefore` may run past quote expiry (`authorizationMayOutliveQuote`); the merchant still refuses a paid request after the quote expires, and the window is capped at 7 days + 160 s.

## What the mock checks, and what the live run showed

The fixture `MockGatewayProvider` (`scripts/e2e/mockGateway.ts`) checks the signature under the GatewayWalletBatched domain, requirements against the authorization, the 7-day minimum, a Gateway balance, and nonce reuse. It could not confirm four assumptions. The LIVE run on 2026-11-19 (below) confirmed all four:

| # | Assumption | LIVE result (2026-11-19) |
| --- | --- | --- |
| 1 | Gateway accepts Verity's derived nonce (the SDK normally uses a random one) | **Confirmed.** `verify` returned `isValid: true` and `settle` returned `success: true` for nonce `0xa532…cee2`. |
| 2 | What `settle().transaction` contains | **Circle's transfer UUID** (`018a216c-72ff-454b-94b1-9bfbdf637f2d`), the same value as the transfer `id`. It is not an onchain tx hash. Verity already stores it as an opaque reference. |
| 3 | `searchTransfers({ nonce })` finds the transfer right after `settle()` | **Confirmed.** The first lookup, 1 s after settle, found it (status `received`). The merchant answered `200` on the first request; the `202` retry path was not needed. |
| 4 | The transfer record exposes `txHash` for the batch | **Confirmed.** `received` with `txHash: null` for the first 4 minutes; about 10 minutes after settle, `refresh` saw `completed` with batch tx `0x3b31471543ae1a1bd08cdff377c57b9586c1c8ae7bd759703b5a1c3ebcaebd82`. |

## Live run (Arc Testnet, LIVE)

```bash
npm run arc:gateway                       # balances, read-only (default)
npm run arc:gateway -- deposit --live     # one 0.01 USDC Gateway deposit (refuses if >= 0.001 is available)
npm run arc:gateway -- pay --live         # one 0.001 USDC purchase through the full Verity flow
npm run arc:gateway -- refresh            # read-only: poll Circle for the batch status, record it
```

`deposit` and `pay` print a dry run without `--live`. **Each needs the owner's approval first.** Set `VERITY_ENV_FILE` to read keys from another checkout's `.env.arc-testnet`; keys are never printed. Buyer and merchant state persist in `.verity/gateway-*.sqlite` (ignored), so re-running `pay` resumes the same purchase with the same signed authorization and never settles twice. Each run writes `samples/arc-gateway-live-<command>.json` (public data only).

What is LIVE and what is FIXTURE in `pay`:

- LIVE: Circle Gateway facilitator `verify` and `settle`, Circle transfer lookups, the Arc Testnet Gateway balance, and the payer's EIP-3009 signature under GatewayWalletBatched v1.
- FIXTURE: the NYC contract analysis and the evidence bytes. The merchant runs in-process on 127.0.0.1 with a per-process bearer token.
- The runner pins the live seller address as `payTo` in the buyer's trusted catalog for this item. The shared catalog pins the placeholder `0x2222…2222`, and the buyer correctly refused the live merchant's quote until then. The merchant identifies itself with the catalog's `merchantId` (`verity-demo-merchant`) because the buyer allowlists merchants by catalog entry.

### Result of the approved run (2026-11-19)

| Item | Value |
| --- | --- |
| Payer (buyer) | `0xDd50F276dE43DdFc4D8A4dACA59901c64207b4CB` |
| Seller (`payTo`, receipt signer) | `0x0B5343FD96AF324B789fbd980f177241B7455b05` |
| Gateway deposit | None made in this run. The payer already held 0.01 USDC available in Gateway, so the guard skipped it. |
| Purchase | `purchase-live-6c672f194930d40dae57d10d`, 1000 base units (0.001 USDC), policy `allow/nanopayment` |
| Circle transfer (`paymentRef`) | `018a216c-72ff-454b-94b1-9bfbdf637f2d` |
| Delivery | `200` on the first paid request; DeliveryReceiptV2 and body hash verified by the buyer; ledger `accepted_by_gateway` |
| Payer Gateway balance | 0.01 to 0.009 USDC available |
| Batch settlement | `completed`, batch tx `0x3b31471543ae1a1bd08cdff377c57b9586c1c8ae7bd759703b5a1c3ebcaebd82`. Buyer ledger `batch_settled`, reservation `spent`; merchant record `completed` with the same tx (`samples/arc-gateway-live-refresh.json`). |
| Seller Gateway balance | 0 to 0.001 USDC available after the batch |
| QuickNode | `not_claimed` (unchanged policy) |

Two earlier attempts in the same session were refused before any money moved, and both stay as safeguards. The buyer rejected an unlisted merchant ID, then a `payTo` that disagreed with the catalog.

A third attempt reached Circle and got `unsupported_network` from `verify`. `BatchFacilitatorClient` defaults to the mainnet host `https://gateway-api.circle.com`. `createLiveGatewayProvider` now passes `ARC_TESTNET_GATEWAY_API` (`https://gateway-api-testnet.circle.com`), the host the SDK's own `GatewayClient` uses for testnet. A failed verify releases the merchant's claim, so the retry reused the same signed authorization.

### Credentials and funding

| Item | Where it lives | Purpose |
| --- | --- | --- |
| `VERITY_PAYER_PRIVATE_KEY` | `.env.arc-testnet` (ignored), never logged | signs EIP-3009 under GatewayWalletBatched; makes the deposit |
| `VERITY_MERCHANT_PRIVATE_KEY` | `.env.arc-testnet` | seller `payTo`; `GatewayClient` for `searchTransfers` / `getTransferById`; signs DeliveryReceiptV2 |
| Circle facilitator | `ARC_TESTNET_GATEWAY_API` | verify / settle; no API key needed on testnet |

Funding on Arc Testnet (chain `eip155:5042002`, Gateway domain 26, USDC `0x3600000000000000000000000000000000000000`, GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`):

1. Buyer wallet: testnet USDC from https://faucet.circle.com. Arc gas is paid in USDC, so keep a little extra for the deposit transaction.
2. One-time Gateway deposit (onchain): `npm run arc:gateway -- deposit --live` (0.01 USDC, enough for ten purchases). Check with `npm run arc:gateway`.
3. Seller wallet: needs no USDC to receive; gas only if it withdraws.

Sources: Circle docs ("Add nanopayments to an x402 seller/buyer", "Reconcile nanopayments", contract addresses, supported blockchains) and circlefin/arc-nanopayments (`lib/x402.ts`, `agent.mts`).
