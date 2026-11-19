# QuickNode settlement reconciliation

Matches Arc Testnet USDC settlements to stored purchases from a QuickNode Streams webhook. Builds on the [Arc Testnet evidence purchase](arc-testnet-purchase.md).

## Stream

| Field | Value |
| --- | --- |
| API | `POST https://api.quicknode.com/streams/rest/v1/streams`, header `x-api-key` |
| `network` | `arc-testnet`. **Unconfirmed:** QuickNode lists Arc Testnet as a Streams network, but the docs do not show its API slug. Confirm with `GET /streams` or the dashboard. |
| `dataset` | `block_with_receipts` |
| Backfill range | `start_range` = `end_range` = `72781628`, `dataset_batch_size` 1 |
| `filter_function` | Base64 of [`quicknode/verity-usdc-filter.js`](../../quicknode/verity-usdc-filter.js), with `TARGET_TX_HASHES` set to the purchase transaction for the backfill. An empty list keeps every USDC `AuthorizationUsed` receipt for a tip stream. |
| Destination | `webhook` to `https://<public-host>/webhooks/quicknode`, `compression: "none"`, `max_retry: 3`, `retry_interval_sec: 1`, `post_timeout_sec: 30`, `security_token` (at least 32 characters) |

`npm run quicknode:backfill` prints the exact body, with the security token redacted. Pass `-- --create` to create the stream. It needs `QUICKNODE_API_KEY`, `VERITY_WEBHOOK_URL`, `VERITY_QN_SECURITY_TOKEN`, and `QUICKNODE_ARC_TESTNET_SLUG`, set in the environment or in the gitignored `.env.quicknode`.

For a tip stream, set `fix_block_reorgs: 1`. Arc has deterministic finality (its `finalized` block equals `latest`), and the ledger only records a settlement at or below the finalized height.

## Webhook

`POST /webhooks/quicknode` (`src/reconciliation/webhook.ts`):

1. Read the raw body. If `Content-Encoding: gzip`, decompress it first.
2. Authenticate `X-QN-Signature == hex(HMAC-SHA256(security_token, X-QN-Nonce + X-QN-Timestamp + body))` with a constant-time compare. Otherwise return 401 and persist nothing.
3. Event ID = `sha256(stream-id + "\n" + body)`. A QuickNode retry carries the same bytes, so it maps to the same event regardless of nonce.
4. In one SQLite transaction: insert the event (`INSERT OR IGNORE`), reconcile each match, then return 200.

## Matching

For each USDC `AuthorizationUsed(authorizer, nonce)` in a successful receipt:

- Look up the stored authorization by `(chain 5042002, token 0x3600…0000, payer, nonce)`.
- Require a USDC `Transfer(payer, request.payTo, request.amount)` in the same receipt. Also require that the stored tx hash, if any, equals the observed hash, and that the reservation was not released.
- On a match, insert `settlements` (unique on purchase, on `(chain, token, payer, nonce)`, and on `(chain, tx, log index)`), mark the authorization `settled`, and move a `held` reservation to `spent`. A replay hits the unique keys and returns `settlement_already_recorded`.
- Otherwise record a finding instead of a settlement: `unmatched_payment`, `mismatch`, or `failed_receipt`.

The settlement is recorded with `settlement_status = confirmed`, `delivery_status = pending`, and `ledger_outcome = settlement_confirmed_delivery_pending`. It becomes `reconciled` when the buyer accepts a verified [`DeliveryReceiptV1`](delivery-receipt-v1.md) for the same tx. The live purchase's merchant artifact was a fixture, and no receipt was issued for it, so its delivery stays pending.

## What was run

`npm run quicknode:backfill` fetched block 72781628 and its receipts from Arc Testnet RPC. It shaped them as a QuickNode `block_with_receipts` batch, ran the stream filter locally, signed the result with the QuickNode HMAC scheme and a local token, and POSTed it to the real handler over HTTP. **QuickNode did not deliver it.** The ledger row's `source` says `local-replay:…` for that reason; a real stream delivery records `quicknode-streams`.
