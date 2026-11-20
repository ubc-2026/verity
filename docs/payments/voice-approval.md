# Voice-based spending approvals (ElevenLabs)

Large purchases (above the 0.50 USDC gap tier, up to the 2.00 USDC cap) need the owner. Verity calls the owner with ElevenLabs, the owner answers yes or no, and a yes is followed by a wallet signature.

**Voice is the interface; the signature is the authorization.** A spoken "yes" is logged as `verbal_yes` and changes nothing else. Funds are released only by `PaymentStore.recordOwnerApproval`, which verifies the EIP-712 `OwnerApproval` signature from the enrolled owner wallet.

## Flow
1. `BuyerService.purchase` records the purchase as `awaiting_approval` and holds the budget.
2. If an `ownerCaller` is configured, Verity calls the owner once per purchase. The call says what it wants to buy, from whom, the price and why (`buildCallSummary`, built from `explainDecision`).
3. Outcomes, all written to `approval_decisions`:
   - `verbal_yes`: still `awaiting_approval`; the owner must now sign.
   - `approved`: written when a valid wallet signature is stored.
   - `denied`: the owner said no. The purchase becomes `denied` and the reservation is released.
   - `timed_out`: no answer, a failed call, or an unclear answer. Treated as deny.
4. A purchase still `awaiting_approval` after its request expires is denied by `PaymentStore.denyExpiredApprovals(now)`. Call it from whatever runs periodically.

A denied purchase is final. It can never be signed, and the (mission, contract, evidence type) pair stays used, so the same gap is not bought again in that mission.

## One-time spoken code (stranger answers the phone)
Pass `ownerCodeDisplay` to `BuyerService`. Before each call Verity makes a random 4-digit code and passes it to that function, which must show it somewhere only the owner sees (a screen, not the call). The agent asks the person to read it back, and Verity compares it in code. A yes with a missing or wrong code is a denial. The expected code is never sent to the agent and never stored or logged. Wire the display to the owner's own screen, not to anything the caller or agent can read.

### Live check by the agent (voice-verify Worker)
So that a stranger never hears the purchase details, the agent checks the code while the person is still on the line. `voice-verify/` is a small separate Cloudflare Worker with KV. Verity registers an HMAC of the code (never the code) before the call; the agent's `verify_code` tool sends the spoken digits to `/verify`, which answers only verified or not and the attempts left. A code lives 5 minutes, allows 3 attempts, and is single use. If registration fails, Verity places no call. The agent ends the call without details when the code is not verified. Verity still compares the spoken digits after the call as a second check.

Deploy: `cd voice-verify`, create the KV namespace and paste its id into `wrangler.jsonc`, set the two secrets with `npx wrangler secret put VOICE_ADMIN_SECRET` and `VOICE_TOOL_SECRET`, then `npx wrangler deploy`. Set `VOICE_VERIFY_URL`, `VOICE_ADMIN_SECRET` (and `VOICE_TOOL_SECRET`, which goes into the ElevenLabs tool header) in `.env`.

## Configuration
Without all four values the call is skipped and the owner only gets the explanation text, as before.

| Variable | Meaning |
| --- | --- |
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `ELEVENLABS_AGENT_ID` | Conversational AI agent that makes the call |
| `ELEVENLABS_PHONE_NUMBER_ID` | ElevenLabs phone number the call comes from |
| `OWNER_PHONE_NUMBER` | The enrolled owner's number |
| `ELEVENLABS_PHONE_PROVIDER` | Optional. `sip_trunk` if the ElevenLabs number is a SIP trunk; omit for Twilio |
| `VOICE_VERIFY_URL` | Base URL of the deployed voice-verify Worker |
| `VOICE_ADMIN_SECRET` | Shared by Verity and the Worker. Keys the HMAC and authorizes `/challenge` |
| `VOICE_TOOL_SECRET` | Shared by the Worker and the ElevenLabs tool. Authorizes `/verify` |
| `ELEVENLABS_CODE_FIELD` | Optional. Data-collection field holding the spoken digits (default `spoken_code`) |
| `ELEVENLABS_DECISION_FIELD` | Optional. Data-collection field holding `yes` or `no` (default `owner_decision`) |

Use `elevenLabsConfigFromEnv(process.env)` and pass `new ElevenLabsOwnerCaller({ config })` to `BuyerService` as `ownerCaller`.

## ElevenLabs agent setup (done in the ElevenLabs dashboard)
- Create a Conversational AI agent and import a phone number (Twilio or SIP) that can place outbound calls.
- Prompt it to read `{{purchase_summary}}`, ask for a clear yes or no, and tell the owner that nothing is authorized until they sign with their wallet.
- Add a data-collection field named `owner_decision` that captures `yes` or `no`.

## Not verified live
The request and response shapes in `ElevenLabsOwnerCaller` (`/v1/convai/twilio/outbound-call`, `/v1/convai/conversations/{id}`, `analysis.data_collection_results`) follow ElevenLabs' public API and are tested against a fake `fetch` only. No real call has been placed from this repository. Check them against the current ElevenLabs docs before the first live run.
