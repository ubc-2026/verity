# Overdue delivery incidents

This is the input contract for the Grok Bot overdue-delivery incident workflow described in the [README](../../README.md#grok-bot-overdue-delivery-incidents). The reconciliation ledger is not in this repository yet. The workflow runs on labeled fixtures. Payments and security (Decong) connects the real ledger by implementing the event and read-back interfaces below.

Grok Bot runs Verity's overdue-delivery incident workflow. When the reconciliation ledger reports that an Arc Testnet USDC payment is confirmed but the merchant missed its deadline to deliver verified evidence, it POSTs a `verity.overdue_delivery.v1` event to a Grok Bot webhook routine. Grok Bot rechecks the latest purchase state in the ledger, then opens at most one card per purchase on a private incident Page, using an `environment:purchaseId:exceptionType` key so replays and restarts never create duplicates. The card records missing verified delivery, which is overdue evidence and not a finding about the merchant's conduct, and it points the owner to the purchase's delivery record. Grok Bot only reads the ledger and only writes to the incident Page, so wallet keys and raw evidence stay inside Verity.

The webhook URL and sender key are provided privately by the Grok Bot owner. This repository does not store them. The workflow stores no secrets, wallet keys, authorizations, or raw evidence. Only redacted status fields and public testnet references belong on the incident card.

Network context (configurable in the bot runtime):

- Arc Testnet chain ID: `5042002`
- USDC (6 decimals): `0x3600000000000000000000000000000000000000`
- Explorer base (default): `https://explorer.testnet.arc.io` (`VERITY_EXPLORER_BASE`)
- Transaction link: `https://explorer.testnet.arc.io/tx/{txHash}`, or `{VERITY_EXPLORER_BASE}/tx/{txHash}` when the base is overridden

## Event schema: `verity.overdue_delivery.v1`

The ledger emits this event when a delivery deadline passes. The routine consumes one JSON object and validates it strictly. Unknown fields, missing fields, wrong types, or values that fail the rules are rejected (`skipped_invalid`) and create no incident.

| Field | Type | Rules |
| --- | --- | --- |
| `schema` | string | Must be exactly `verity.overdue_delivery.v1`. |
| `eventId` | string | Non-empty. Identifies this emission; not used as the incident key. |
| `environment` | string | Exactly `fixture` or `arc-testnet`. |
| `purchaseId` | string | Non-empty Verity purchase identifier. |
| `exceptionType` | string | Must be exactly `paid_delivery_missing`. |
| `ledgerStatus` | string | Non-empty. Informational on the event; eligibility uses the rechecked ledger record. |
| `settlementConfirmed` | boolean | JSON boolean only (`true` / `false`, not `0` / `1` / `"true"`). |
| `txHash` | string | `0x` followed by exactly 64 hexadecimal characters. |
| `amountBaseUnits` | string | Integer string of USDC base units (6 decimals). Example: `"50000"` is 0.05 USDC. No leading zeros except `"0"`. Not a JSON number. |
| `merchantLabel` | string | Non-empty public label for the purchase. |
| `deliveryDeadlineUtc` | string | ISO 8601 timestamp ending in `Z`, for example `2026-11-16T17:00:00Z`. Optional fractional seconds are accepted. No other timezone offset. |
| `emittedAtUtc` | string | ISO 8601 timestamp ending in `Z`, when the ledger emitted this event. |

### Example event (fixture)

```json
{
  "schema": "verity.overdue_delivery.v1",
  "eventId": "evt-fx-001",
  "environment": "fixture",
  "purchaseId": "fx-001",
  "exceptionType": "paid_delivery_missing",
  "ledgerStatus": "Paid, delivery missing",
  "settlementConfirmed": true,
  "txHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
  "amountBaseUnits": "50000",
  "merchantLabel": "Verity demo merchant (fixture)",
  "deliveryDeadlineUtc": "2026-11-16T17:00:00Z",
  "emittedAtUtc": "2026-11-16T17:00:01Z"
}
```

POST this object as the body of the routine webhook when a delivery deadline passes. Authenticate with the sender key using whatever authentication the Grok Bot webhook trigger requires. The webhook URL and sender key are provided privately by the Grok Bot owner. The event carries none of the wallet keys, raw evidence, or private contract data.

## Ledger recheck: `GET /purchases/{purchaseId}`

Before opening a card, the workflow rechecks the latest purchase state. It does not trust the event alone.

When `VERITY_LEDGER_URL` is set:

```http
GET {VERITY_LEDGER_URL}/purchases/{purchaseId}
Accept: application/json
Authorization: Bearer {VERITY_LEDGER_TOKEN}
```

- `{purchaseId}` is URL-encoded.
- The token is a read-only credential scoped to the incident feed.
- The client uses a short timeout (3 seconds).
- A successful response is `200` with a JSON object for the latest record.

When `VERITY_LEDGER_URL` is unset, the workflow reads a fixture ledger in the Grok Bot runtime (a map of `purchaseId` to the latest record). That fixture store is not part of this repository.

### Latest record fields

The GET body is the latest record itself (not wrapped). It includes at least:

| Field | Type | Rules |
| --- | --- | --- |
| `purchaseId` | string | Must match the event. |
| `txHash` | string | `0x` + 64 hex; compared case-insensitively to the event. |
| `amountBaseUnits` | string | Integer string; compared numerically to the event. |
| `ledgerStatus` | string | Eligibility is based on this exact value. |
| `settlementConfirmed` | boolean | Must be JSON `true` to open an incident. |
| `deliveryDeadlineUtc` | string | ISO 8601 ending in `Z`. Compared to current UTC. |
| `merchantLabel` | string | Used on the card when present. |

Optional fields such as `environment` or a fixture `dataLabel` may appear on the record. The workflow ignores unknown ledger fields. HTTP errors, timeouts, invalid JSON, a missing purchase, or a record missing required fields all produce `skipped_ledger_unavailable` and no incident.

## Eligibility rules

An incident is opened only when the latest ledger record satisfies every condition:

1. `ledgerStatus` is exactly `Paid, delivery missing`.
2. `settlementConfirmed` is `true`.
3. `purchaseId`, `txHash`, and `amountBaseUnits` match the event.
4. `deliveryDeadlineUtc` is strictly earlier than now (UTC). Tests may pass a fixed clock to pin the comparison.

Otherwise the processor writes no new card:

| Outcome | When |
| --- | --- |
| `skipped_invalid` | Event failed strict validation. |
| `skipped_ledger_unavailable` | Ledger URL or fixture file failed, or the purchase record is missing or unusable. |
| `skipped_mismatch` | Rechecked `purchaseId`, `txHash`, or `amountBaseUnits` disagrees with the event, or the latest status is none of the handled settlement states (for example `Mismatch`). |
| `skipped_delivery_verified` | Latest `ledgerStatus` is `Reconciled`. |
| `skipped_payment_pending` | `settlementConfirmed` is `false`, or status is `Payment pending` or `Delivered, payment unconfirmed`. |
| `skipped_deadline_not_passed` | Rechecked deadline is still in the future, or equal to now. |

A pending payment, a deadline that has not passed, a reconciled delivery, a mismatch with the event, or an unavailable ledger produces no incident.

## Incident key and idempotency

```text
incidentKey = "{environment}:{purchaseId}:{exceptionType}"
```

Example: `fixture:fx-001:paid_delivery_missing`.

The Grok Bot runtime stores cards outside this repository. Writes are locked and replaced atomically. A replay, retry, or process restart upserts the existing row: `replayCount` and `lastSeenUtc` are updated, and a second card is never created. Fixture cards are labeled `FIXTURE`.

Each card includes `incidentKey`, `environment`, `purchaseId`, formatted `amount` (for example `0.05 testnet USDC`), `amountBaseUnits`, `merchantLabel`, `txHash`, `txUrl`, `deliveryDeadlineUtc`, status `Missing verified delivery`, a note that this is overdue evidence and not a finding about the merchant's conduct, next action `Open the Verity purchase and check the merchant delivery record.`, `createdAtUtc`, and `source` (`fixture-run` or `webhook`).

`txUrl` uses `https://explorer.testnet.arc.io/tx/{txHash}` unless `VERITY_EXPLORER_BASE` sets another explorer base.

The processor prints one JSON line:

```json
{"outcome":"created","incidentKey":"fixture:fx-001:paid_delivery_missing","cardCount":1}
```

`outcome` is `created`, `duplicate`, or one of the `skipped_*` values above. `cardCount` is the number of cards in the store after the call.

## What Decong needs to connect the real ledger

The real ledger is not wired yet. Payments and security (Decong) connects it by:

1. Emitting a `verity.overdue_delivery.v1` event when a delivery deadline passes. POST it to the Grok Bot routine webhook, authenticated with that routine's sender key. The webhook URL and sender key are provided privately by the Grok Bot owner. This repository does not create the routine.
2. Exposing a read-only `GET /purchases/{purchaseId}` that returns the latest record using the field contract above. The bot runtime calls it at `{VERITY_LEDGER_URL}/purchases/{purchaseId}`.
3. Issuing a read-only bearer token (`VERITY_LEDGER_TOKEN`) scoped to that incident feed. The token grants no write access, no wallet access, and no evidence access.
4. Giving the bot runtime `VERITY_LEDGER_URL` and `VERITY_LEDGER_TOKEN`. Optionally set `VERITY_EXPLORER_BASE` when the Arc Testnet explorer is not `https://explorer.testnet.arc.io`.
5. Keeping wallet keys, authorizations, raw evidence, and private contract data inside Verity. The event and GET body carry only the fields in this contract.

## Fixture status

The workflow is fixture-tested in the Grok Bot runtime. This repository does not contain those fixtures.

- An overdue confirmed payment creates one card.
- A replay or restart keeps one card.
- Delivery verified before processing creates zero cards.
- A pending payment, a future deadline, and an unavailable ledger create none.
