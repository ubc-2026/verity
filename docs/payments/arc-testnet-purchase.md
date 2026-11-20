# Arc Testnet evidence purchase

## Live NWS acceptance run

From the repository root, install `npm ci` and the Python dependencies in `analysis/requirements-live.txt`. Use funded Arc Testnet buyer and merchant wallets in `.env.arc-testnet` or the local environment. Set the QuickNode Streams API key, matching webhook signing token, and dedicated HTTPS `VERITY_WEBHOOK_URL` in `.env.quicknode` or the environment. These files are ignored by Git.

1. Run `npm run arc:nws:live -- prepare <Gemini-event> "<outcome>"`. This reads public data, requires an eligible 0.05 USDC proposal, and captures matching NWS evidence. It prints a run ID.
2. Run `npm run arc:nws:live -- receive <run-id>` in a separate terminal. It binds to loopback port 8791 unless `VERITY_ARC_LIVE_PORT` is set. Give the receiver a dedicated HTTPS tunnel route for `/healthz` and `/webhooks/quicknode`. Preserve any existing audit portal route.
3. Run `npm run arc:nws:live -- purchase <run-id>` within 15 minutes of preparation. This checks that the HTTPS route reaches this run's receiver, checks QuickNode access, validates the funded wallets, and permits one capped Arc Testnet payment attempt for the contract in this workspace. If payment status is uncertain, inspect the existing ledger before starting any new attempt.
4. Run `npm run arc:nws:live -- stream <run-id>` to create the one-block, transaction-filtered QuickNode Streams backfill. This consumes QuickNode credits for that block. The run ID serves as the stream's idempotency key. Keep the receiver running until the provider delivers the signed event.
5. Run `npm run arc:nws:live -- report <run-id>`. This requires the authenticated stream event and buyer-verified delivery for the same transaction. It rechecks the saved signature and evidence bytes, then reassesses the exact pre-purchase findings. Share the resulting `report.json`. A valid result can be `unchanged` if the NWS document leaves the settling issuance unknown.

Use the acceptance runner's `stream` stage for this run. The separate `quicknode:backfill` command generates a local replay by default, which cannot satisfy the provider-delivery check.

One 0.05 USDC evidence purchase through the allowlisted merchant, settled on Arc Testnet with EIP-3009. Builds on the [ResearchRequestV1 commitment](research-request-v1.md).

## Qualification (2026-11-17)

| Check | Result |
| --- | --- |
| USDC EIP-712 domain | Read from `0x3600…0000` on chain `5042002`: `name() = "USDC"`, `version() = "2"`, `decimals() = 6`. The computed `DOMAIN_SEPARATOR` matches the contract: `0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0`. The x402 SDK default asset for `eip155:5042002` uses the same values. |
| `TransferWithAuthorization` typehash | `0x7c7c6cdb…2267`, the standard EIP-3009 typehash. |
| Token accepts the Verity nonce | `npm run arc:qualify` simulates `transferWithAuthorization` with an unfunded payer. Correct signature: `ERC20: transfer amount exceeds balance`. Wrong signer: `FiatTokenV2: invalid signature`. The token accepts the domain and derived nonce; only funding is missing. |
| Hosted facilitator | The x402 SDKs and docs list Arc Testnet (USDC, EIP-3009). The hosted `x402.org/facilitator` does **not**: its `/supported` lists only `eip155:84532` (Base Sepolia) for EVM. |
| Facilitator used | Testnet-only self-hosted facilitator (`src/payments/arcFacilitator.ts`), as the pinned README allows: it verifies against the pinned token and broadcasts the exact signed transfer. The relayer key pays gas (Arc gas is USDC) and never holds payer funds. |

## Flow

```text
buildResearchRequest            catalog + validated quote
PaymentStore.reserveAndRecord   one IMMEDIATE transaction:
                                  policy (min, cap, tiers, mission budget incl. reservations)
                                  purchase + reservation(held) + authorization(salt, nonce, request)
authorizeStoredPurchase         signs only from the stored record; stored signature reused on retry
deliverPaidRequest (merchant)   binding + payment checks, durable per-purchase claim, then:
  SelfHostedArcFacilitator      chain/token pinned, nonce == verified nonce, authorizationState unused
                                  simulate, submit, record pending tx, wait for receipt
                                  require status success + AuthorizationUsed(payer, nonce) + Transfer(payer, payTo, 50000)
PaymentStore.recordSettlement   authorization settled, reservation spent
```

Retry guarantees, covered by `test/payments-store.test.ts` and checked live by the script:

- Repeating `reserveAndRecord` and `authorizeStoredPurchase` for the same purchase returns the stored nonce and signature. The signer is not called again, including after reopening the database.
- A different request under the same purchase ID is refused, as is a second purchase for the same mission, contract, and evidence gap.
- Resubmitting the same paid request replays the stored DeliveryReceiptV1 and settles nothing (the durable claim in `merchant_deliveries`). If it ever reached the chain, the used nonce would also be refused.

`scripts/arc-purchase.ts` moved from the removed `handlePaidRequest` to `deliverPaidRequest` in the integration branch. That version of the script has not been run against Arc Testnet; a new live run needs the owner's approval first.

## Run it

```sh
npm run arc:qualify    # read-only; no keys
npm run arc:keygen     # writes .env.arc-testnet (gitignored) with dedicated testnet keys; prints addresses only
# fund both printed addresses at https://faucet.circle.com/ (Arc Testnet USDC)
npm run arc:purchase   # live purchase; records in .verity/payments.sqlite (gitignored)
```

`arc:purchase` checks the chain, domain, keys, and balances first, and prints each blocker instead of signing. It reports the purchase ID, transaction hash, explorer link, receipt checks, and the retry result.

## Scope and labels

- **Live:** Arc Testnet RPC, USDC settlement, on-chain receipt and log checks, durable SQLite records.
- **DEMO FIXTURE:** the merchant runs in-process with the labeled demo artifact. The merchant workstream owns the real HTTP merchant, so HTTP wiring stays pending.
- **Policy:** only tier 1 (0.01–0.10 USDC, automatic) is implemented. Higher tiers are refused until the material-gap rule and owner wallet approval land.
- **Not in this slice:** `DeliveryReceiptV1` signing and buyer-side receipt verification, merchant-side idempotent replay of cached artifacts, QuickNode reconciliation, and on-chain timeout recovery (a pending purchase keeps its reservation and tx hash). Delivery receipts and replay are in [delivery-receipt-v1.md](delivery-receipt-v1.md).
