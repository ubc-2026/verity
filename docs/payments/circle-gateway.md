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
    accepted -> Circle transfer by nonce    -> DeliveryReceiptV2 (purchaseId, transfer ID, nonce, content hash)
buyer: verifyGatewayDelivery (pinned key, binding, keccak256 of bytes, own nonce) -> GatewayLedger: accepted
later: Circle transfer status received -> batched -> confirmed/completed + batch tx -> GatewayLedger: batch_settled
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
- **Duplicate charge:** the merchant's durable claim lets only one request call Gateway `settle()`; a retry replays the stored V2 receipt; Gateway itself refuses a reused nonce (`nonce_already_used`). If `settle()` fails with an unknown outcome, the claim is kept and never resubmitted.
- **One deliberate relaxation:** Circle requires Gateway authorizations to be valid for at least 7 days (`GATEWAY_MIN_AUTH_VALIDITY_SECONDS` in the SDK). On this rail only, `validBefore` may run past quote expiry (`authorizationMayOutliveQuote`); the merchant still refuses a paid request after the quote expires, and the window is capped at 7 days + 160 s.

## What the mock checks, and what is unverified live

The fixture `MockGatewayProvider` (`scripts/e2e/mockGateway.ts`) checks the signature under the GatewayWalletBatched domain, requirements against the authorization, the 7-day minimum, a Gateway balance, and nonce reuse. It cannot confirm, and these are **unverified until a live run**:

1. Gateway accepts Verity's derived nonce (the SDK normally generates a random one).
2. What `settle().transaction` contains (stored as an opaque reference, not used as a tx hash).
3. `searchTransfers({ nonce })` finds the transfer right after `settle()` (the merchant answers `202` and retries until it does).
4. The transfer record exposes `txHash` for the batch (documented by Circle; not in the SDK's TypeScript type).

## Live run: credentials and funding

Nothing below has been done. **A Gateway deposit and a live payment each need the owner's approval first.**

| Item | Where it lives | Purpose |
| --- | --- | --- |
| Buyer EVM private key | `.env.arc-testnet` (ignored), never logged | signs EIP-3009 under GatewayWalletBatched; makes the deposit |
| Seller address | merchant config `payTo` | Gateway credits it |
| Seller private key | `.env.arc-testnet` | `GatewayClient` for `searchTransfers` / `getTransferById` and withdrawals |
| Merchant receipt key | `.env.arc-testnet` | signs DeliveryReceiptV2 (pinned by the buyer) |
| Circle facilitator | `new BatchFacilitatorClient()` default URL | verify / settle; no API key in Circle's sample |

Funding on Arc Testnet (chain `eip155:5042002`, Gateway domain 26, USDC `0x3600000000000000000000000000000000000000`, GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`):

1. Buyer wallet: testnet USDC from https://faucet.circle.com. Arc gas is paid in USDC, so keep a little extra for the deposit transaction.
2. One-time Gateway deposit (onchain): `new GatewayClient({ chain: "arcTestnet", privateKey }).deposit("0.01")`, enough for ten 0.001 USDC purchases. Confirm with `getBalances().gateway.available`.
3. Seller wallet: needs no USDC to receive; gas only if it withdraws.

The live adapter is `createLiveGatewayProvider` in `src/payments/circleGateway.ts` (official `@circle-fin/x402-batching` 4.0.0, `@x402/core` / `@x402/evm` 2.31.0). It is not wired to any script yet; a live runner would pass it as `MerchantService({ gateway })` after approval.

Sources: Circle docs ("Add nanopayments to an x402 seller/buyer", "Reconcile nanopayments", contract addresses, supported blockchains) and circlefin/arc-nanopayments (`lib/x402.ts`, `agent.mts`).
