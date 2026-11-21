# Audit

This directory is the QuickNode reconciliation workstream. QuickNode Streams delivers Arc Testnet blocks to `POST /webhooks/quicknode`. The ledger matches USDC `AuthorizationUsed` and `Transfer` logs to a registered purchase, then compares that settlement with the delivery the buyer already verified.

Arc Testnet chain ID `5042002`. USDC `0x3600000000000000000000000000000000000000` (6 decimals).

## What it decides

| What the stream and the purchase show | Status |
| --- | --- |
| Confirmed transfer and a verified delivery | Reconciled |
| Confirmed transfer, no delivery yet | Paid, delivery missing |
| Delivery verified, matching transfer not confirmed | Delivered, payment unconfirmed |
| Nonce seen, but payer, recipient, amount, or delivery differs | Mismatch |
| A second settlement uses the same nonce | Duplicate payment |
| Waiting for the matching transfer, or the transfer is not final yet | Payment pending |
| A chain ticket that no purchase claimed | Unmatched payment |

A match requires the authorization nonce, the payer, the recipient, and the amount in the same successful transaction. A transfer is final after `FINALITY_DEPTH` later canonical blocks (default 1). Reorg metadata and a parent-hash break drop the displaced block.

When a confirmed payment is still missing delivery after `deliveryDeadlineUtc`, the service queues one `verity.overdue_delivery.v1` event. If `GROK_BOT_WEBHOOK_URL` and `GROK_BOT_WEBHOOK_KEY` are set, it POSTs that event with the key as a bearer token and retries until the response is 200.

## Run

```bash
cd audit
cp .env.example .env
npm test
npm start
```

The read token is entered in the browser at `http://127.0.0.1:8787/`. It is stored in `sessionStorage` and is not written into the page.

### One writer per ledger

Run exactly one audit server per ledger file (`LEDGER_PATH`, default `data/ledger.json`). Do not put several replicas behind a load balancer on the same file or a shared volume. The server enforces this rule:

- At startup it creates `<ledger>.lock` exclusively. A second server on the same file exits with "ledger is already open for writing".
- Before every save it checks the lock is still its own, and refuses to write if not.
- It removes the lock on normal exit, Ctrl-C and SIGTERM.
- A lock left by a crashed server on the same host is taken over at the next start. A lock written by another host is never taken over: stop that server, then delete the lock file.

This rule is what makes webhook replay protection hold. Each accepted delivery's nonce is saved in the ledger in the same write as its blocks. The single writer then sees every receipt, including after a restart, and answers a repeat with `200 {"duplicate": true}` without processing it again.

## QuickNode stream

1. Create a stream for Arc Testnet, dataset `block_with_receipts`.
2. Paste `streams/arc-usdc-filter.js` as the JavaScript filter. It forwards every block header and only USDC `Transfer` and `AuthorizationUsed` logs, and it keeps reorg metadata.
3. Enable **Restream on reorg** (`fix_block_reorgs: 1`).
4. Set the webhook destination to `https://<public-host>/webhooks/quicknode`.
5. Put the stream security token in `QUICKNODE_SECURITY_TOKEN`.

The signature is HMAC-SHA256 over `nonce + timestamp + uncompressed JSON body`, using headers `x-qn-nonce`, `x-qn-timestamp`, and `x-qn-signature`. Gzip bodies are decompressed before the check. A delivery with those headers is rejected with 401 when the signature is wrong or the timestamp is stale. QuickNode's Check Connection probe sends no signature headers; that probe gets `200` and is not written to the ledger.

When `PORTAL_URL` and `PORTAL_WRITE_TOKEN` are set, each signed delivery also posts its `AuthorizationUsed` tickets to the payment portal. The portal decides which tickets belong to a nanopayment purchase. A portal failure is logged and does not change the response QuickNode receives. Direct-rail purchases (`arc-eip3009`) can match a ticket. Gateway nanopayments (`circle-gateway-batched`) are recorded by the payment service and are not claimed from a chain log.

Set `EXPECTED_NETWORK` only after the stream's `metadata.network` value is confirmed in a test delivery. Leave it unset until then so a surprising slug does not pause the stream.

## Payment-service handoff

Register a purchase when the authorization is submitted:

```http
POST /purchases
Authorization: Bearer $VERITY_WRITE_TOKEN
```

```json
{
  "purchaseId": "purchase-1",
  "requestHash": "0x…",
  "nonce": "0x…",
  "payer": "0x…",
  "payTo": "0x…",
  "amountBaseUnits": "50000",
  "token": "0x3600000000000000000000000000000000000000",
  "chainId": 5042002,
  "merchantLabel": "Verity demo merchant",
  "deliveryDeadlineUtc": "2026-11-20T17:00:00Z",
  "environment": "arc-testnet"
}
```

After the buyer verifies the merchant receipt, report the result. Do not send the evidence bytes.

```http
POST /purchases/purchase-1/delivery
Authorization: Bearer $VERITY_WRITE_TOKEN
```

```json
{ "ok": true, "contentHash": "0x…", "detail": "receipt matched" }
```

The Grok Bot recheck is `GET /purchases/{purchaseId}` with `VERITY_LEDGER_TOKEN`. That response carries the purchase id, environment, amount, status, settlement flag, deadline, merchant label, and transaction hash. It does not carry wallet keys, authorizations, or evidence.
