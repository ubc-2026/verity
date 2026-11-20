[README (7).md](https://github.com/user-attachments/files/35008499/README.7.md)
# Verity

**Prediction-market research with accountable agent spending.**

Verity reads the rules of a prediction-market contract, identifies evidence that could clarify how it resolves, and proposes buying that evidence. The payment service enforces the owner’s spending rules. An audit trail links each purchase to both the onchain transfer and the resource the merchant delivered.

> **Project status** · UBC 2026 hackathon design. The demo targets testnet USDC and a controlled merchant. This brief describes the planned workflow. Install commands and a demo URL are pending.

## How it works

Imagine an election market asks whether a candidate will win. The quoted price reflects market expectations. To understand how the contract settles, Verity checks which source the rules recognize, when it is checked, and whether the result must be certified.

1. **Identify the gap.** Verity pulls contract text and market metadata from the Gemini Exchange prediction-market API. Verity analyzes that data and returns structured findings with quoted rules, a risk assessment, and the evidence needed to resolve each material question.
2. **Request a quote.** The agent proposes a specific resource from an approved merchant. The merchant returns an x402 quote for the resource.
3. **Apply the spending policy.** The payment service checks the amount, budget, merchant, and purpose. For a purchase that needs human approval, ElevenLabs explains the request and the owner authorizes it with a wallet signature.
4. **Pay and verify delivery.** The merchant checks the signed authorization against the request before submitting the transfer. The buyer checks the returned resource against the quoted digest.
5. **Reconcile and report.** QuickNode Streams supplies onchain payment records. Verity matches those records against the purchase and delivery records, then updates the risk assessment with any verified evidence.

## Architecture

| Component | Responsibility | Technology |
| --- | --- | --- |
| Market analysis | Extract resolution criteria, flag ambiguous terms or sources, identify correlated outcomes, and propose evidence to inspect | Gemini Exchange prediction-market API and structured JSON |
| Payment service and merchant | Validate the quote, bind the authorization to the exact research request, and deliver the resource after settlement | x402, testnet USDC, EIP-3009 |
| Spending controls | Check budget and merchant allowlists, request owner approval when needed, and log the decision | Policy engine, ElevenLabs, owner wallet |
| Reconciliation | Match settlement and delivery evidence and show discrepancies | QuickNode Streams, webhook, database, dashboard |

### Request-bound payments

The payment service hashes a canonical request that includes the resource URL, parameters, amount, recipient, and expiry. The proposed design commits to that hash through the nonce in the EIP-3009 authorization. The merchant reconstructs the request from what it actually receives and verifies the amount, recipient, signature, expiry, and nonce before submitting the payment.

Once the merchant delivers the resource, the buyer hashes the received bytes and compares the result with the quoted digest. This checks that the delivery matches the purchased resource. The agent evaluates the relevance and credibility of the evidence during its follow-up analysis.

### Owner approval

The policy engine applies the configured budget, merchant allowlist, and purpose checks. Eligible small purchases can proceed automatically. Purchases above the configured approval threshold require a wallet signature from the owner. ElevenLabs can explain the resource, merchant, price, and reason for the purchase. The payment service denies requests that time out or lack a valid wallet signature. Spending thresholds are configurable and remain open for the demo.

### Audit trail

The backend links the onchain transaction to the purchase record using the payment authorization and matching transfer fields. The purchase record connects that authorization to the request hash and delivery evidence.

| Evidence observed | Dashboard status |
| --- | --- |
| Confirmed transfer and verified delivery | Reconciled |
| Confirmed transfer with missing delivery | Paid, delivery missing |
| Verified delivery with no confirmed matching transfer | Delivered, payment unconfirmed |
| Different amount, recipient, or content digest | Mismatch |
| A second transfer for the same purchase | Duplicate payment |

### Overdue delivery incidents (Grok Bot)

When a confirmed payment reaches its delivery deadline with no verified delivery (`Paid, delivery missing`), the ledger is planned to POST a `verity.overdue_delivery.v1` event to a Grok Bot webhook routine. Grok Bot treats the event only as a prompt to look. It rereads the purchase from a read-only ledger endpoint and opens at most one card per `environment:purchaseId:exceptionType` key on a private incident Page. It writes nothing back to Verity.

- **Authentication.** The webhook checks a static bearer key. It does not sign the body or check a timestamp, so the event proves only that the sender holds the key. The URL and key stay in the sender's runtime secrets, never in this repository.
- **Replays.** A replayed, retried, or forged event cannot open a card unless the latest ledger record still shows the overdue payment. Repeats update the existing card instead of adding one.
- **Fixture and live data.** Fixture events use `environment: "fixture"`, are checked against a fixture ledger in the Grok Bot runtime, and produce cards labeled `FIXTURE`. Live events use `arc-testnet` and the real ledger endpoint.

Status: the routine is fixture-tested in the Grok Bot runtime, which is outside this repository. The Verity side (the overdue event and the read-only `GET /purchases/{purchaseId}` feed) is built in `src/alerts/` and checked against a contract model of the routine in `npm run e2e`. Neither is deployed, and no live event has been sent. Field contract and wiring steps: [Overdue delivery incidents](docs/grok-bot/overdue-delivery-incidents.md).

## Connected fixture workflow

`npm run e2e` runs one market from research through risk analysis, an evidence purchase, and the updated assessment. Settlement is stubbed and nothing leaves the machine. Commands, scenarios, and what is fixture versus live: [Connected fixture workflow](docs/integration.md).

## Demo plan

1. Open a prediction-market contract and highlight a specific ambiguity in its resolution rules.
2. Use a controlled merchant to demonstrate an automatically approved testnet purchase. Show the quote, delivered evidence, and matching onchain transaction.
3. Trigger a purchase that requires owner approval. Show the voice explanation and record the wallet approval before the payment proceeds.
4. Return an intentionally different payload from the demo merchant and show the resulting digest mismatch in the dashboard.

### Integration milestones

- Agree on the canonical request format and nonce construction, then verify the buyer and merchant compute matching values.
- Exercise the quote, approval, payment, and delivery flow with a controlled merchant and testnet USDC.
- Configure the QuickNode webhook and confirm that settlement and delivery records reconcile.
- Confirm the voice flow and prepare a labeled recording in case the live call is unavailable.

Circle nanopayments for per-fact pricing are a stretch goal.

## Team workstreams

| Workstream | Deliverable |
| --- | --- |
| Market analysis | Contract parser, structured analysis, and evidence-gap detection |
| Payments | x402 client and demo merchant, authorization signing, and request binding |
| Approvals | Spending policy, voice flow, and owner signature validation |
| Audit | QuickNode integration, reconciliation logic, and dashboard |
