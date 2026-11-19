# Arc Testnet evidence purchase

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
