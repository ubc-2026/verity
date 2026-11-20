[README (7).md](https://github.com/user-attachments/files/35008499/README.7.md)
# Verity

**Prediction-market research with accountable agent spending.**

Verity reads the rules of a prediction-market contract, identifies evidence that could clarify how it resolves, and proposes buying that evidence. The payment service enforces the owner’s spending rules. An audit trail links each purchase to both the onchain transfer and the resource the merchant delivered.

> **Project status** · UBC 2026 hackathon design. The demo targets testnet USDC and a controlled merchant. This brief describes the planned workflow. To run it locally, see [Run it from the browser](#run-it-from-the-browser-fixture-first). A public demo URL is pending.

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

## Run it from the browser (fixture first)

The run page (`site/src/Run.tsx`, opened at `#run`) runs one market end to end against the app API (`npm run app`). No key, wallet, or chain is needed.

```bash
npm ci
python -m venv analysis/.venv
analysis/.venv/bin/pip install -r analysis/requirements.txt   # Windows: analysis\.venv\Scripts\pip
(cd site && npm ci && npm run build)                         # writes site/dist/index.html
npm run app                                                  # http://127.0.0.1:8790/#run
```

- `npm run app` prints a one-time operator token on its own console. Set `VERITY_OPERATOR_TOKEN` (24+ characters) to choose it. The token is checked on the server and never sent to visitors.
- For live editing, run `cd site && npm run dev`. Vite proxies `/api` to the app server.
- With no app server (for example a static deploy), the page shows a read-only FIXTURE preview recorded by `npm run app:snapshot` (`site/src/fixture-preview.json`).
- Optional settings: `VERITY_OWNER_ADDRESS` enrolls a real owner wallet, `VERITY_GATEWAY_RAIL=1` shows the archived Gateway purchase, and `VERITY_PYTHON` selects the Python interpreter.

### The agent's decision loop

1. **Read.** The person picks a Gemini Exchange market. The page shows the snapshot time, the bid and ask, and the market-implied price (the mid of a two-sided book). A missing, one-sided, stale, crossed, or closed quote is labeled and gets no implied price.
2. **Score.** The rules analyst scores ambiguity, source, liquidity, and correlation from 1 to 3 each. Each score cites the rule text. The settlement-risk rating is shown apart from the price.
3. **Find the gap and check free sources.** Open material gaps are listed. Free official sources and cached evidence are checked first, and the decision log records each check.
4. **Buy or abstain.** Verity proposes one allowlisted catalog item for one gap, with a price ceiling, or it states why it buys nothing.
5. **Pay under policy (operator).** The operator requests the quote. Policy then decides allow, owner approval, or refuse. The owner can sign the exact request in a wallet, reject it, or let it expire.
6. **Verify, then reconcile.** The buyer checks the receipt signature, the request binding, and the hash of the delivered bytes. Delivery, settlement, and reconciliation are shown as three separate states.
7. **Reassess.** The analysis reads the evidence only after the receipt and the bytes are verified.

### Spending safeguards

| Safeguard | Where it is enforced |
| --- | --- |
| Merchant and catalog allowlists, evidence type, parameters, price ceilings | `assessPolicy`, `acceptPurchaseProposal`, `buildResearchRequest` |
| The selected contract only | `acceptPurchaseProposal(..., { expectedContractId })` |
| Amount, quote expiry, authorization window | `buildResearchRequest`, `PaymentStore`, `authorizeStoredPurchase`, merchant `verifyPaidRequest` |
| Request-hash and nonce binding | `ResearchRequestV1` commitment; the merchant checks `X-Verity-Binding` before settling |
| Budget, held funds included | `PaymentStore` counts `held` and `spent` reservations. Rejection and expiry release the hold |
| Pause switch | Durable in `PaymentStore`. Checked on reserve, approval, signing, and resumed purchases |
| Owner approval bound to the exact request | EIP-712 `OwnerApproval` over purchase ID, request hash, amount, recipient, and expiry. It is verified against the enrolled owner |
| One settlement and one verified delivery | Durable merchant claim per purchase. Retries return the stored authorization. Ledger keys are unique per nonce, tx, and purchase |
| Webhook authenticity, replay, finality | QuickNode HMAC, a 300 s timestamp window, event IDs from the body bytes, and matching only at or below the finalized block |
| Operator-only steps | `/api/operator/*` needs the operator bearer token. Visitors can read data and run fixture analysis only |
| Server-only credentials | The payer, merchant, webhook, and feed credentials stay in the server process. Responses never include them |

`test/app.test.ts` and the browser run covered these paths: happy path in both event orders, replay and retry, no purchase, approval rejected, approval expired, wrong approval signer, budget denial, expired quote, receipt rejection with one overdue incident across replays, pause, and forged or stale webhooks.

### Arc Testnet contracts used

| Contract | Address |
| --- | --- |
| Chain | Arc Testnet, chain ID `5042002` (`eip155:5042002`) |
| USDC (EIP-3009, domain `USDC` v`2`) | `0x3600000000000000000000000000000000000000` |
| Circle Gateway Wallet (opt-in rail) | `0x0077777d7eba4688bdef3e311b846f25870a19b9` |

The fixture run sends nothing on chain. Its tx hashes are derived from the nonce. The archived Gateway purchase (`samples/arc-gateway-live-*.json`) records Circle transfer ID `018a216c-72ff-454b-94b1-9bfbdf637f2d` and Arc batch transaction `0x3b31471543ae1a1bd08cdff377c57b9586c1c8ae7bd759703b5a1c3ebcaebd82`.

### What is fixture, live, or blocked

| Capability | State | Missing step |
| --- | --- | --- |
| Analysis, quote, policy, approval, payment, delivery, QuickNode join, reassessment | FIXTURE | None for the fixture run |
| Market snapshot from Gemini Exchange | LIVE read-only | Live markets are shown but not analyzed or bought from |
| Arc Testnet direct settlement | Blocked | Not wired into the app server. `scripts/arc-purchase.ts` has not been run live in this version. A live spend needs the owner's approval |
| QuickNode live ingestion | Blocked | `npm run webhook:serve` has the checks. No live delivery has been received, and the last key returned 403 |
| Circle Gateway rail | Opt-in. Archived LIVE purchase; the analysis and evidence bytes in it were FIXTURE | PR #10 review found no blocker. Open items are in its review notes |
| Grok overdue alert | FIXTURE | The real routine has not been called |
| ElevenLabs voice | Blocked | Explanations are text only. No authorized integration has been captured |
| Standard x402 | Blocked | The transport uses `X-Verity-*` headers. Interoperability has not been checked |
| Research history store (instruments, quotes, sources, assessment versions) | FIXTURE and CAPTURED data on embedded Postgres; the same suite passed on Postgres 17 in local Docker | The Supabase project is not connected. The remaining steps are in [db/research/README.md](db/research/README.md) |
| Research evaluation set (19 weather and sports cases) | FIXTURE and CAPTURED, plus 2 LIVE checks | 0 of 19 cases have been reviewed by a person. See [eval/research/v1/report.md](eval/research/v1/report.md) |

## Research history (fixture first)

The app server keeps market history in a private Postgres schema (`db/research/0001_research.up.sql`) and serves it read-only at `/api/research`. The run page shows it in section V, "Recorded history". Without credentials it uses embedded Postgres in `.verity/research-pg`, migrated and seeded on start. The payment stores stay in SQLite.

- **Instruments** are keyed by exchange, event ticker and the outcome's instrument symbol. Quote snapshots keep the venue and capture times, provider, bid, ask, market state and provenance. A replayed input adds nothing.
- **The market-implied probability** is the mid of a two-sided, uncrossed, open book only, and it is reported apart from the settlement-risk rating. Missing, one-sided, crossed, closed, stale and unavailable quotes are labeled.
- **Assessments** are append-only versions. A reassessment points at its parent and records the rubric version, the quote snapshot, the source versions, the cited claims, the gap and the decision. The database refuses a changed finding unless the evidence was verified.
- **Roles.** Only the ingest role can write. The reader role sees display views only. `anon`, `authenticated` and `service_role` get nothing. The research code imports nothing from the payment code.

```bash
npm run app                                   # migrates and seeds .verity/research-pg, then serves /api/research
npm run research:eval                         # scores eval/research/v1 (needs VERITY_PYTHON); add --live for 2 live checks
npm run research:migrate -- plan              # against VERITY_RESEARCH_MIGRATE_URL in .env.research; apply needs the reviewed checksum
```

The vertical slice is the NYC high-temperature market, outcome 62°F to 63°F (`GEMI-WXHIGH-NYC-2611190459-62TO63`). It has three quotes: the workbook snapshot from 2026-11-17 (FIXTURE, date only, 56¢ implied) and two reads of the settled event from the public API (CAPTURED 2026-11-20, closed, no implied price). Receipt-verified FIXTURE evidence moved the rating from 8 Medium to 7 Medium. Schema, roles, migration and rollback steps are in [db/research/README.md](db/research/README.md).

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
