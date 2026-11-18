# Verity

**Financial intelligence infrastructure for autonomous agents**

Verity reads prediction-market contracts, identifies evidence gaps that could affect how those contracts resolve, and buys narrowly scoped research with testnet USDC. An owner sets the spending policy and signs approvals for larger purchases. The dashboard shows what was requested, what was paid, what arrived, and what remains unresolved.

**UBC 2026 track** · Agentic Payments and AI  
**Chain target** · Arc Testnet  
**Status** · Hackathon implementation plan. Live integrations and demo proof are tracked below.

## What we are building

The demo follows one Gemini Exchange contract from risk analysis to a verified evidence purchase. Google Gemini produces a structured assessment that separates the market price from the risks in the contract's rules, sources, liquidity, and any linked outcomes. If an evidence product can answer a material open question, the agent can request a quote. A deterministic payment service enforces the spending policy, and an independent reconciliation path checks the result.

The MVP is research-only. Use read-only exchange data, an allowlisted demo merchant, a dedicated testnet spending wallet, and one settlement network. The merchant can serve a labeled fixture while the testnet transfer and audit flow run live. Circle Gateway Nanopayments and additional merchants are stretch work.

## Architecture and team handoffs

~~~mermaid
flowchart TD
    M["Gemini market data"] --> R["Risk analysis"]
    R --> D["Purchase decision"]
    D --> P["Payment policy"]
    H["Owner approval"] --> P
    P --> X["x402 merchant"]
    X --> C["Arc USDC settlement"]
    X --> A["Reconciliation"]
    C --> Q["QuickNode Streams"]
    Q --> A
    A --> V["Audit dashboard"]
~~~

| Owner | Deliverable | Handoff |
| --- | --- | --- |
| Person 1 · Market intelligence | Implement get_risk_analysis(contract_id). Retrieve one real Gemini Exchange contract and normalize its market data, resolution rules, sources, prices, and timestamps. Apply Google Gemini structured output and validate it in code. | RiskAnalysisV1 with evidence gaps, citations, and data confidence. |
| Person 2 · Agent decisions and spending economics | Implement generate_purchase_request(risk_analysis). Map material evidence gaps to catalog items, reject weak or duplicate purchases, and model the $25 demo budget. | PurchaseProposalV1 or null with a logged reason. Propose thresholds and fixtures for the payment service. |
| Person 3 · Merchant and demo integration | Publish a small evidence catalog and implement one x402 merchant. Serve versioned evidence, enforce the request-binding checks, and sign delivery receipts. Wire catalog and audit states into the demo. | Merchant quote, paid response bytes, signed receipt, and merchant verification key. |
| Decong · Hardened payments and security | Own the commitment, EIP-3009 signing boundary, spending reservations, wallet approval verification, and QuickNode reconciliation. Freeze the shared interfaces and coordinate the integrated demo. | One successful Arc testnet purchase plus evidence that altered, duplicate, and unauthorized requests fail safely. |

Keep credentials and the payment signer outside the model and UI. The research model and decision engine can propose a catalog item and a reason. The payment service derives the merchant URL, recipient, asset, network, and amount from the allowlisted catalog and validated quote.

## 1. Market risk analysis

| Input or output | Minimum fields |
| --- | --- |
| Normalized contract | Exchange instrument symbol, question, full available rules and source references, outcomes, observed prices and timestamps, and liquidity or depth when available. |
| Risk result | Contract ID, source snapshot time and hash, one score per category, overall summary, evidence gaps, citations, and uncertainty. |
| Purchase proposal | Proposal ID, contract ID, evidence gap ID, catalog item ID, catalog parameters, rationale, and maximum acceptable amount in USDC base units. |

Score resolution ambiguity, quality of the resolution source, and liquidity from 1 to 5. Score dependence when the contract has multiple legs. **1** means low observed risk, **3** means a meaningful uncertainty, and **5** means a material risk with concrete evidence. Use null when data is missing or the category does not apply, with a reason. Quote the relevant rule or market field for each material finding. Show the price and its timestamp separately from the risk scores. Preserve the original analysis and log which findings changed after the evidence arrived.

Start with a live API read and save one timestamped snapshot for a repeatable fixture run. Label source mode visibly. Market rules, news, and merchant payloads are untrusted inputs. Validate model output against the application schema, use fixed upstream hosts, and route purchases through catalog IDs. Missing or stale rules should lower confidence and can prevent a purchase when the evidence need cannot be validated. See the [Gemini Exchange events API](https://developer.gemini.com/rest-api/prediction-markets/events/list-events) and [Google Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output).

## 2. Hardened x402 payments

### What is signed

EIP-3009 signs the payer, recipient, amount, validity window, and a 32-byte nonce in the USDC token's EIP-712 domain. Verity binds the resource to that signature by deriving the signed nonce from a hash of the exact request and a fresh random salt. The merchant must recompute the commitment from the request it actually received before submitting it for settlement. The x402 payload's resource metadata is checked against the quote as well. See [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) and the [x402 exact EVM scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md).

Freeze a single versioned object, ResearchRequestV1, for the agent and merchant. This is an example fixture. Production values come from the configured catalog, the authenticated merchant quote, and the actual payer.

~~~json
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
~~~

~~~text
requestHash = keccak256(UTF8(JCS(ResearchRequestV1)))
salt        = CSPRNG(32 bytes)
nonce       = keccak256(UTF8("verity:eip3009:nonce:v1") || requestHash || salt)
~~~

Use [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html) for deterministic JSON and Ethereum Keccak-256 for hashing. Here, `||` concatenates raw bytes, including the decoded 32-byte hash and salt. Use exact decimal strings for USDC base units, lowercase hex for addresses and digests after validation, integer UTC epoch seconds for time, and a strict parameter schema that rejects unknown fields and duplicate JSON keys. The configured HTTPS origin and exact path identify the resource, and the accepted POST body carries its parameters. Disallow redirects and URL query strings on the MVP endpoint. The merchant derives the expected origin from its server configuration.

**Shared test vector** · Use the exact JSON object above and the following UTF-8 response bytes with no trailing newline. The salt is fixed for this test vector. Generate fresh random salts for real requests.

~~~text
response    = {"source":"mock","summary":"Cutoff policy excerpt for the demo."}
salt        = 0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
requestHash = 0x7ce16c2335bbb15089c7c81b64e93a8605d19730e02d368b2ac4a333c2c38c0f
nonce       = 0x310ef615ef725fa65943c2eb63e52ddd57c17f689b4b99e6aa05fec5e1f4968c
~~~

### Request, authorize, deliver

1. The allowlisted merchant returns HTTP 402 with the x402 v2 PAYMENT-REQUIRED header and a Verity quote. The quote pins the request, price, merchant recipient, expiry, content type, and Keccak-256 hash of a versioned response artifact. The buyer checks the quote against its own proposal and configuration.
2. In one database transaction, the payment service checks policy, reserves funds, consumes any required owner approval, and records the finalized request, commitment, and nonce. Sign only from that durable record and verify the same reservation before sending the authorization.
3. The buyer retries the same POST with the x402 `PAYMENT-SIGNATURE` header and a Verity-specific `X-Verity-Binding` header carrying the purchase ID, quote ID, and salt. The merchant loads its saved quote and verifies it belongs to the authenticated buyer session and purchase. It rebuilds the request from the actual route and body and recomputes the expected nonce. It checks exact network, token, signer, recipient, amount, validity, signature, nonce freshness, and availability of the quoted bytes. Use durable uniqueness for the purchase, quote, and authorization key `(chain, token, payer, nonce)` to make concurrent requests idempotent.
4. The merchant submits through the configured x402 settlement adapter. Once settlement succeeds, return the quoted bytes, the x402 `PAYMENT-RESPONSE`, and a merchant-signed receipt. Sign `DeliveryReceiptV1` with the merchant's pinned receipt key in a separate EIP-712 domain. Include the merchant ID, purchase ID, request hash, nonce, chain ID, token, transaction hash, content type, content hash, and delivery timestamp. An authenticated retry for the same purchase can return its cached artifact and receipt.
5. Independently hash the received entity body bytes before JSON parsing, verify the receipt with the merchant's pinned key, and compare the digest with both the receipt and the original quote. A valid receipt attests to the merchant's statement. A buyer-side hash match establishes that the bytes received match the quoted artifact. Source credibility, timeliness, and relevance still belong in the research assessment.

If the network or merchant times out after signing, mark the attempt pending and reconcile by the existing nonce or transaction. Never create a second authorization for that purchase while the first can still settle or while its outcome is unknown. Release a signed reservation only after confirming it cannot settle and was unused, or account for it as spent once confirmed. Maintain short authorization windows and keep pending signatures out of client logs, model context, and audit exports.

The MVP uses a single USDC EIP-3009 adapter. Before wiring the UI, confirm the configured facilitator supports Arc Testnet with this token, the token's EIP-712 domain, and our derived nonce in a complete verify-and-settle smoke test. If a hosted facilitator is unavailable, use a testnet-only x402 facilitator that verifies against the pinned USDC token and broadcasts the exact signed transfer. Register the deployed facilitator and freeze the adapter before demo recording. Circle Gateway Nanopayments use a separate Gateway balance and settlement flow. Revisit their receipt and reconciliation model before adding them. See [x402 network support](https://github.com/x402-foundation/x402/blob/main/docs/core-concepts/network-and-token-support.mdx) and [Circle Nanopayments](https://www.circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet).

## 3. Owner spending controls

These are proposed demo policy values. All amounts use integer USDC base units internally. One USDC equals 1,000,000 base units on Arc's ERC-20 interface.

| Per purchase | Decision |
| --- | --- |
| $0.01–$0.10 | Automatic after shared safety checks. |
| $0.11–$0.50 | Automatic only for a material unresolved gap with a catalog match and no suitable free or cached evidence. |
| $0.51–$2.00 | Require a wallet signature from the enrolled owner. |
| Above $2.00 | Reject under the demo policy. |

Use whole-cent quotes for the demo. Enforce the $25 mission budget against confirmed spend **plus outstanding reservations**. Apply the pause switch, merchant and token allowlists, quote expiry, purchase cap, and duplicate evidence checks to every tier. Group repeated proposals by contract and evidence gap to prevent splitting one purchase across several quotes. Policy changes and budget resets belong to the authenticated owner. Gas or facilitator costs should be tracked separately if the demo incurs them.

For the large tier, ElevenLabs explains the evidence gap, merchant, amount, and deadline, then directs the owner to the wallet approval screen. Use ElevenLabs Agents for an outbound call if telephony is configured. A browser voice flow can present the same approval prompt. Wallet authorization is a one-use, expiring EIP-712 signature over the exact request hash, purchase ID, approval nonce, and expiry under a Verity-specific domain with the chain ID and an environment-specific domain salt. The backend checks the enrolled owner, consumes the approval, and binds it to the single reserved purchase. Voice responses are informational.

The signer is a dedicated low-balance testnet wallet behind the payment service. These are service-enforced limits. A compromised signer key can bypass them, and pausing the service stops new signatures while already-issued authorizations remain valid until expiry or verified cancellation. Use a funded testnet wallet and keep private keys server-side. A separately enforced wallet policy is a future hardening step. See the [ElevenLabs Agents phone integration](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration/).

## 4. QuickNode reconciliation and audit

| Stream setting | Target |
| --- | --- |
| Network | Arc Testnet, chain ID 5042002. |
| Dataset | Block with Receipts. |
| Filter | Successful receipts with USDC AuthorizationUsed events for the test payer allowlist or USDC Transfer events to the demo merchant allowlist. Keep the original receipt identity and matching logs. |
| Destination | HTTPS webhook at `/webhooks/quicknode`. Validate the configured QuickNode signature and check for replays before ingestion. |
| Purpose | Supply independent settlement evidence for the audit ledger and flag unmatched or inconsistent transfers. |

Persist events before acknowledging the webhook. Store chain ID, block number and hash, transaction hash, log index, payer, recipient, token, amount, and authorization nonce where available. Deduplicate redeliveries and handle canonical block corrections. Correlate a purchase using the pinned token and EIP-3009 authorization event for the payer and nonce, then require the exact USDC transfer to the expected recipient and amount in that same successful transaction. Keep ambiguous transfers unmatched. Use the chain's confirmation/finality behavior before promoting an observed payment to confirmed. See [QuickNode Arc support](https://www.quicknode.com/docs/arc/api-overview), [Streams datasets](https://www.quicknode.com/docs/streams/data-sources), and [webhook verification](https://www.quicknode.com/docs/streams/destinations/webhooks).

| Observed state | Ledger outcome |
| --- | --- |
| Confirmed transfer and matching signed receipt plus verified response bytes | Reconciled. |
| Confirmed transfer, no verified delivery by deadline | Paid, delivery missing. |
| Verified delivery, no matching confirmed settlement by deadline | Delivered, payment unconfirmed. |
| Wrong payment fields, wrong payload digest, or invalid receipt | Mismatch. Preserve the evidence and surface the reason. |
| A distinct second settlement tied to the same purchase or an unexpected extra transfer | Duplicate or unmatched payment. Replayed webhook events remain one record. |

Use append-only audit events with a derived UI status. Export the canonical request and its hash, nonce and salt, policy and approval decisions, onchain transaction and log reference, merchant receipt and public verification key, and buyer-side digest. Restrict audit exports to authorized users and keep secrets and reusable authorization material out of them. Retain response bytes only where permitted so an auditor can recompute the digest. Show the explorer link alongside the delivery state. The chain provides independently verifiable payment evidence. Delivery depends on the merchant receipt and the buyer's verification of the received bytes.

## Team setup and integration order

1. Share one contract snapshot, one Version 1 catalog item, and one request schema. Use the same fixture in the analyst, policy service, and merchant.
2. Run a sequential fixture purchase with the mock merchant locally. Confirm that both sides compute the same hash and nonce, and that altering a request field or the delivered content is flagged.
3. Fund the dedicated Arc Testnet payer and facilitator as required. Pin chain ID 5042002 and USDC ERC-20 address 0x3600000000000000000000000000000000000000. Run one transfer and confirm the exact log pair before integrating QuickNode Streams. Use the [Circle faucet](https://faucet.circle.com/) and [Arc Testnet explorer](https://explorer.testnet.arc.io/).
4. Configure the real Gemini Exchange feed, Google Gemini API credentials, merchant and facilitator URLs, pinned recipient and receipt key, enrolled owner wallet, Arc RPC, QuickNode webhook signing configuration, and ElevenLabs credentials. Keep secrets in the runtime environment and publish only an example environment file with empty values.
5. Wire the audit dashboard and approval screen to the verified backend states. Expose fixture mode explicitly if an upstream source is offline.

**Before publishing** · Add the repo's actual install, migration, start, test, and demo commands, plus the actual demo URL, recorded video link, owner-approved team credits, and contract addresses used. The setup above describes the planned sequence. Repo commands and deployment proof are pending.

## Demo acceptance

| Test | Expected result |
| --- | --- |
| Valid purchase | A real testnet transfer and a verifiable receipt reconcile to the same request. |
| Change URL, parameters, merchant, amount, token, chain, or requested artifact after approval | Merchant or policy rejects before submitting settlement. |
| Wrong owner, expired or reused approval, paused mission, exceeded cap | Payment service issues no new authorization. |
| Two concurrent purchases near the budget limit | Atomic reservation prevents overspending. |
| Replayed payment or timeout after submission | At most one transfer for the authorization. The retry returns or tracks the original purchase. |
| Merchant sends wrong content or never sends it | Ledger shows mismatch or paid, delivery missing. |
| Replayed or unauthenticated webhook | No duplicate ledger event. Unauthenticated payloads are rejected. |

**2–3 minute demo** · Open a live Gemini contract → show a specific resolution risk → buy a $0.05 evidence item → display the Arc transaction and verified delivery → show an over-threshold quote requiring owner approval → alter one bound field and show the rejection. Record the real QuickNode-driven status update and capture audio if entering ElevenLabs.

## Submission checklist

| Entry | Evidence needed |
| --- | --- |
| Agentic Payments and AI | Working onchain integration and documented agent loop and spending controls. |
| Best use of Arc | Core settlement on Arc, the contract addresses used, and a documented Arc integration. |
| Gemini Prediction Markets | Demonstrate use of the Gemini Exchange prediction-market API. Its market-data endpoints qualify under the organizer guide. |
| QuickNode Streams | A working Stream with a real filter and destination, demonstrable in the ledger, plus its configuration in this README. |
| ElevenLabs | Voice as part of the real owner approval flow, documented here and audible in the demo video. |

**Deadline** · Friday, November 20, 2026 at 1:00 p.m. ET / noon CT. Submit a public repo, a working demo, a judge-accessible 2–3 minute video, and the project write-up. Final presentations are in person. Confirm final selections against the integrations that are actually running. See [Devpost](https://ubc-hackathon-2026.devpost.com/) and the [official organizer guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit).

