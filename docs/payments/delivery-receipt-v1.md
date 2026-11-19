# DeliveryReceiptV1

After settlement, the merchant signs a receipt that binds one purchase to the bytes it delivered. The buyer verifies the receipt against a pinned merchant key and hashes the raw response bytes before accepting delivery. Code: [`src/payments/deliveryReceipt.ts`](../../src/payments/deliveryReceipt.ts) (schema, signing, verifier) and [`src/payments/merchantDelivery.ts`](../../src/payments/merchantDelivery.ts) (merchant path).

## Schema

The receipt is signed as EIP-712 typed data with domain `{ name: "VerityDeliveryReceipt", version: "1" }`. The domain has no `chainId` and no `verifyingContract`; the chain is a field of the message.

| Field | EIP-712 type | Wire (JSON) | Source |
| --- | --- | --- | --- |
| `version` | `string` | `"verity-delivery-receipt-v1"` | constant |
| `merchantId` | `string` | identifier | `MerchantConfig.merchantId` |
| `merchant` | `address` | lowercase hex | the receipt signer's address |
| `purchaseId` | `string` | identifier | `request.purchaseId` |
| `quoteId` | `string` | identifier | `request.quoteId` |
| `requestHash` | `bytes32` | lowercase hex | `keccak256(UTF8(JCS(ResearchRequestV1)))` |
| `contentHash` | `bytes32` | lowercase hex | `keccak256(delivered bytes)`, which must equal `request.expectedContentHash` |
| `chainId` | `uint256` | JSON number | `request.chainId` |
| `txHash` | `bytes32` | lowercase hex | settlement transaction |
| `issuedAt` | `uint64` | JSON number (Unix seconds) | merchant clock at signing |
| `signature` | — | 65-byte hex | EIP-712 signature over the fields above |

On the wire, the signed receipt travels in the `X-Verity-Receipt` response header as base64url of its RFC 8785 canonical JSON. This header format is **provisional**, like `X-Verity-Binding`; the merchant workstream needs to confirm it. The response body is the artifact bytes, unchanged.

The receipt's identity is its EIP-712 digest (`receiptDigest`). The signature is not part of that digest.

## Buyer verifier interface

```ts
interface TrustedMerchant { merchantId: string; receiptSigner: Hex } // pinned in config, never read from the response

verifyDelivery(args: {
  receiptHeader: string | undefined;
  body: Uint8Array;              // raw response bytes, before any parsing
  trusted: TrustedMerchant;
  request: ResearchRequestV1;    // the buyer's own stored request
  expectedTxHash?: Hex | null;   // settlement tx, when known
}): Promise<
  | { ok: true; receipt: SignedDeliveryReceiptV1; digest: Hex; contentHash: Hex }
  | { ok: false; code: "malformed_receipt" | "wrong_signer" | "binding_mismatch" | "content_mismatch" | "tx_mismatch"; reason: string }
>;

acceptDelivery(args: { response: { body; receiptHeader }; trusted; request; expectedTxHash?; store: DeliveryAcceptanceStore; now })
  // verifyDelivery, then store.recordVerifiedDelivery; returns the body only if both pass
```

The verifier checks, in order:

1. The receipt parses as strict JSON: no duplicate keys, no unknown fields.
2. Its signature recovers to `trusted.receiptSigner`, and its `merchant` field names that same key.
3. Its `merchantId`, `purchaseId`, `quoteId`, `requestHash` and `chainId` match the buyer's stored request, and its `contentHash` matches `request.expectedContentHash`.
4. `keccak256(body)` equals `contentHash`.
5. Its `txHash` equals `expectedTxHash`, when one is given.

`ReconciliationLedger` implements `DeliveryAcceptanceStore`:

- The ledger keeps one accepted receipt per purchase. Accepting the same receipt again returns `delivery_already_recorded`. A different receipt for the same purchase returns `mismatch`.
- If a confirmed settlement exists with the same tx, the purchase becomes `reconciled`. If there is no settlement yet, the delivery waits as `delivered_payment_unconfirmed`, and a later settlement observed through QuickNode reconciles it.
- If the tx differs from the observed settlement or from the buyer's recorded tx, the ledger records a `receipt_mismatch` finding and the settlement's outcome becomes `mismatch`.

## Merchant path and retries

`deliverPaidRequest(input, deps)` takes the following steps:

1. Runs `verifyPaidRequest` on the request.
2. Claims the purchase in `merchant_deliveries`, which is unique on the purchase and on the nonce.
3. Settles the payment once.
4. Signs a receipt, but only for loaded bytes whose hash is the quoted `expectedContentHash`.
5. Stores the receipt and returns `200` with the artifact and the `X-Verity-Receipt` header.

| Record state | Retry of the same paid request |
| --- | --- |
| `delivered` | Re-verified at the original verification time, then the stored receipt is replayed byte for byte. Settlement is not called. |
| `settled` (artifact was missing) | The receipt is signed now. Settlement is not called again. |
| `submitted` (the receipt wait timed out) | `settlement.resume(txHash)` waits on the recorded tx without resubmitting. With no resume path, the merchant returns `202` with the tx hash. |
| `claimed` (a concurrent request is settling) | `202 settlement in progress` |
| any state, different authorization | `409` |

A failure before submission (for example, the RPC is not Arc Testnet, or the nonce is already used on chain) releases the claim and returns `502`. A failure after submission keeps the tx hash. A reverted transfer returns `502`, and a timeout returns `202`.

Re-verifying at the original verification time keeps a paid buyer from being stranded after `validBefore`. A retry with a tampered body or signature still fails verification.

## Status

- `npm run delivery:demo` and `test/delivery.test.ts` run locally with **DEMO FIXTURE** data. Settlement is stubbed there, and the merchant receipt key is public Anvil key #2.
- No receipt has been issued for the live Arc Testnet purchase `purchase-arc-1794970282`. Its merchant artifact was a fixture, so its ledger row stays `settlement_confirmed_delivery_pending`.
- Still open:
  - wiring the HTTP merchant,
  - confirming the header format with the merchant workstream,
  - the production location of the receipt key and how it is rotated,
  - a `delivery missing by deadline` sweep.
