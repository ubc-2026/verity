# ResearchRequestV1 commitment

`ResearchRequestV1` is the single versioned object that the buyer (the payment service) and the merchant both commit to. Its hash, combined with a random salt, becomes the EIP-3009 `nonce`. Before submitting payment for settlement, the merchant recomputes the commitment from the request it received and verifies that it matches the signed nonce.

**Source of truth:** the schema, rules, and test vector below are copied from the README at commit [`ad091fc`](https://github.com/ubc-2026/verity/blob/ad091fc15a1d909fa0062a341dc9fc35bad4dd4e/README.md#2-hardened-x402-payments), section "2. Hardened x402 payments". The current README keeps the same formulas and does not conflict with them.

Implementation: [`src/payments/researchRequest.ts`](../../src/payments/researchRequest.ts).

## Commitment

```text
requestHash = keccak256(UTF8(JCS(ResearchRequestV1)))
salt        = CSPRNG(32 bytes)
nonce       = keccak256(UTF8("verity:eip3009:nonce:v1") || requestHash || salt)
```

- JCS is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), implemented here with the `canonicalize` package. Keccak-256 is Ethereum Keccak, implemented with `viem`.
- `||` concatenates raw bytes. The 32-byte `requestHash` and `salt` are decoded from hex before concatenation.
- Each new authorization gets a fresh salt. A retry of the same purchase reuses the stored salt and nonce, so it never creates a second authorization.

## Schema (pinned example fixture)

```json
{
  "version": "verity-research-request-v1",
  "purchaseId": "purchase-demo-001",
  "quoteId": "quote-demo-001",
  "merchantId": "verity-demo-merchant",
  "method": "POST",
  "resourceUrl": "https://merchant.example/evidence/resolution-source",
  "parameters": {
    "contractId": "demo-contract-001",
    "evidenceType": "resolution_source"
  },
  "contentType": "application/json",
  "expectedContentHash": "0xecb8d0303298a3bff971405264cc3670f3297da1468bd6c39a3e32e5abd2dda9",
  "chainId": 5042002,
  "token": "0x3600000000000000000000000000000000000000",
  "payer": "0x1111111111111111111111111111111111111111",
  "payTo": "0x2222222222222222222222222222222222222222",
  "amount": "50000",
  "validAfter": 1795185000,
  "validBefore": 1795185300
}
```

The example above is a fixture. In production, values come from the configured catalog, the authenticated merchant quote, and the actual payer.

## Validation rules

These rules come from the pinned README. `parseResearchRequest` is the only place that validates and normalizes a request.

| Rule | Enforcement |
| --- | --- |
| Strict schema | Unknown fields are rejected, at the top level and inside `parameters`. |
| Duplicate JSON keys | Rejected at any depth before schema validation (`parseStrictJson`, which uses `@humanwhocodes/momoa`). |
| Amounts | USDC base units as an exact decimal string: positive, no leading zeros, at most uint256. A JSON number is rejected. |
| Addresses and digests | Lowercase hex after validation. Mixed-case addresses must pass the EIP-55 checksum. |
| Time | Integer UTC epoch seconds. `validBefore` must be later than `validAfter`. |
| Resource | `https` origin and exact path only. No query string, fragment, or credentials. The URL must already be canonical (the WHATWG `href`); it is rejected, not rewritten. |
| Method | `POST`. The POST body carries the parameters. |

## Shared test vector

Use the exact JSON object above and these UTF-8 response bytes, with no trailing newline. The salt is fixed only for this vector.

```text
response    = {"source":"mock","summary":"Cutoff policy excerpt for the demo."}
salt        = 0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
requestHash = 0x7ce16c2335bbb15089c7c81b64e93a8605d19730e02d368b2ac4a333c2c38c0f
nonce       = 0x310ef615ef725fa65943c2eb63e52ddd57c17f689b4b99e6aa05fec5e1f4968c
```

`keccak256(response)` equals the fixture's `expectedContentHash`. All three values are checked in `test/researchRequest.test.ts` and printed by `npm run fixture`.

## Buyer and merchant flow

1. **Buyer** (`src/payments/buyer.ts`): `buildResearchRequest` takes the endpoint, token, recipient, and chain from the trusted catalog. It takes the price, IDs, and content hash from the validated quote. The quote must match the catalog and the proposal parameters, and its price must stay within both the catalog and proposal ceilings. `prepareAuthorization` then stores the salt and nonce per purchase and returns the `X-Verity-Binding` header value.
2. **Merchant** (`src/payments/merchant.ts`): `verifyPaidRequest` loads the saved quote named in the binding header and checks that it belongs to the buyer session. It rebuilds the request from the quote, the actual route and body, and the signed authorization. It then recomputes the nonce and checks the network, token, recipient, amount, validity window, EIP-712 signature, and artifact availability. The validity window must end no later than the quote's expiry (`validBefore <= expiresAt`). A request target that fails to parse, or is not the canonical configured origin plus exact path, is rejected with 400. `handlePaidRequest` calls the settlement adapter only after all of these checks pass.

**Who enforces what.** The USDC token contract knows nothing about `ResearchRequestV1`. At settlement it verifies only the EIP-3009 `TransferWithAuthorization`: payer signature, recipient, amount, validity window, and that the signed nonce is unused. The resource binding (which route, body, quote, and content hash the nonce commits to) is checked only by the merchant, before it calls settlement. The merchant's own signature check is an early rejection, not a substitute for the token's check.

## Provisional choices (need teammate sign-off)

The pinned README does not specify the following. Each is narrow on purpose and easy to change.

- **Identifier grammar.** `purchaseId`, `quoteId`, `merchantId`, and `contractId` must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. `evidenceType` must match `^[a-z][a-z0-9_]{0,63}$`. `contentType` is a lowercase media type with no parameters.
- **`X-Verity-Binding` encoding.** The value is RFC 8785 JSON: `{"purchaseId":…,"quoteId":…,"salt":"0x…"}`. Merchant workstream to confirm.
- **Quote shape.** `VerityQuote` in `src/payments/quote.ts` is the minimum this slice needs. Merchant workstream to confirm.
- **Authorization window.** The buyer default is a 300 s window with `validAfter` backdated 30 s, capped at quote expiry. The merchant rejects windows longer than `maxAuthorizationWindowSeconds` (600 s in the fixture).
- **Token EIP-712 domain.** Confirmed on chain as `{ name: "USDC", version: "2" }`. See [Arc Testnet evidence purchase](arc-testnet-purchase.md).

## Pending

- Durable, transactional authorization store, plus uniqueness on `(chain, token, payer, nonce)`. Today only the in-memory fixture store exists.
- Nonce freshness and on-chain `authorizationState` check on the merchant side.
- Live x402 settlement adapter and Arc Testnet facilitator qualification. The fixture uses a stub adapter.
- HTTP wiring for the 402 quote and the paid retry (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`).
