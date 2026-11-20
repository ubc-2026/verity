# Payment portal

Database and page for the USDC logs QuickNode delivers, plus the nanopayment purchases those logs can match.

This folder is the workstream for a branch that is not on GitHub yet. Suggested name: `feat/payment-portal`. Create that branch from current `main`, copy `portal/` and `.gitignore` in, and leave out `node_modules/`, `data/`, and `.env`.

## Two ways a payment leaves

The nanopayments branch (`feat/circle-nanopayments`) sends USDC on Arc Testnet in one of two ways.

| Rail | What is sent | What this portal does with a chain log |
| --- | --- | --- |
| `arc-eip3009` | One EIP-3009 authorization. The nonce is the hash of the research request plus a salt. The same transaction transfers USDC from the payer to the merchant. | Looks up that nonce. Payer, recipient, and amount must match. A later block makes it final. A verified delivery then makes the row **Reconciled**. |
| `circle-gateway-batched` | A 0.001 USDC nanopayment. Circle Gateway batches many of these into one chain transaction. | Stores the purchase and Circle's transfer id. A USDC log is not treated as proof of this purchase. The row stays **not claimed**. |

The audit stream keeps watching every USDC `AuthorizationUsed` log. It posts those logs here. This database is what decides whether a log belongs to a purchase we sent.

## Run

```bash
cd portal
npm install
cp .env.example .env
npm start
```

The page is `http://127.0.0.1:8788/`. The read token is `PORTAL_READ_TOKEN`. The first table is the QuickNode feed: each USDC transfer and each authorization ticket, newest first.

## What the payment service posts

`POST /purchases` with `Authorization: Bearer $PORTAL_WRITE_TOKEN` after `reserveAndRecord` has a nonce:

```json
{
  "purchaseId": "purchase-demo-001",
  "missionId": "mission-001",
  "quoteId": "quote-demo-001",
  "contractId": "demo-contract-001",
  "evidenceType": "resolution_source",
  "merchantLabel": "Verity demo merchant",
  "rail": "arc-eip3009",
  "amountBaseUnits": "50000",
  "chainId": 5042002,
  "token": "0x3600000000000000000000000000000000000000",
  "payer": "0x1111111111111111111111111111111111111111",
  "payTo": "0x2222222222222222222222222222222222222222",
  "nonce": "0x310ef615ef725fa65943c2eb63e52ddd57c17f689b4b99e6aa05fec5e1f4968c",
  "salt": "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "requestHash": "0x7ce16c2335bbb15089c7c81b64e93a8605d19730e02d368b2ac4a333c2c38c0f",
  "deliveryDeadlineUtc": "2026-12-31T00:00:00Z",
  "environment": "arc-testnet"
}
```

`POST /purchases/{id}/delivery` records the buyer's verified delivery (`ok`, `contentHash`).

`POST /purchases/{id}/gateway` records a Gateway nanopayment: `paymentRef`, `receiptDigest`, and later `batchStatus` (`received`, `batched`, `confirmed`, `completed`, `failed`) plus `batchTxHash`.

The audit posts `POST /observations` with the chain head and each `AuthorizationUsed` it saw. Set `PORTAL_URL` and `PORTAL_WRITE_TOKEN` on the audit process. A portal outage does not fail the QuickNode webhook.

## Reads

`GET /purchases` and `GET /purchases/{id}` use the read token. `GET /unmatched` is the latest chain tickets that no purchase claimed.
