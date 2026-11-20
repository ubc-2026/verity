/**
 * npm run voice:test -- places ONE real ElevenLabs call to OWNER_PHONE_NUMBER and prints what the owner said.
 * It checks the agent, phone number and `owner_decision` field only. No purchase, no payment, no wallet signature,
 * and nothing is written to any store.
 *
 *   node scripts/voice-test.ts              # dry run: shows which settings are present, places no call
 *   node scripts/voice-test.ts --live       # places the call (uses ElevenLabs and telephony credit)
 *   node scripts/voice-test.ts --live --timeout 90   # seconds to wait for an answer (default 120)
 *
 * It also tests the one-time code check: the code is printed here, the agent asks the person to read it, and the
 * result shows whether what they said matches. The agent is never told the code.
 *
 * Reads ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID and OWNER_PHONE_NUMBER from the
 * environment or .env. Values are never printed; the owner number is shown only as its last four digits.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { voiceChallengeFromEnv } from "../src/payments/voiceChallenge.ts";
import { ElevenLabsOwnerCaller, codeMatches, elevenLabsConfigFromEnv, generateApprovalCode } from "../src/payments/voiceApproval.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dotEnv = join(root, ".env");
if (existsSync(dotEnv)) process.loadEnvFile(dotEnv);

const REQUIRED = ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_PHONE_NUMBER_ID", "OWNER_PHONE_NUMBER"] as const;
const missing = REQUIRED.filter((name) => !process.env[name]);
for (const name of REQUIRED) console.log(`${process.env[name] ? "set    " : "MISSING"}  ${name}`);
const config = elevenLabsConfigFromEnv(process.env);
if (!config) {
  console.log(`\nBLOCKED: set ${missing.join(", ")} in the environment or ${dotEnv}.`);
  process.exit(2);
}

const live = process.argv.includes("--live");
const timeoutIndex = process.argv.indexOf("--timeout");
const timeoutSeconds = timeoutIndex >= 0 ? Number(process.argv[timeoutIndex + 1]) : 120;
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 600) {
  console.log("BLOCKED: --timeout must be 10 to 600 seconds.");
  process.exit(2);
}

// Same shape as buildCallSummary(): short, one statement, no question (the agent asks it).
const summary =
  "This is a test call, not a real purchase. Verity wants to buy cat-filing-packet-v1 from verity-demo-merchant " +
  "for 0.80 USDC on testnet, to resolve the regulatory filing question on contract demo-contract-001.";

console.log(`\nowner number  ...${config.ownerPhoneNumber.slice(-4)}`);
console.log(`decision field ${config.decisionField ?? "owner_decision"}`);
if (!live) {
  console.log("\nDRY RUN: no call placed. Add --live to call the owner number above.");
  process.exit(0);
}

// The one-time code: shown here (stand-in for a screen only the owner sees), never sent to the agent.
const codeIndex = process.argv.indexOf("--code"); // lets a caller choose and announce the code before the phone rings
const code = codeIndex >= 0 ? (process.argv[codeIndex + 1] ?? "") : generateApprovalCode();
if (!/^\d{4}$/.test(code)) {
  console.log("BLOCKED: --code must be exactly four digits.");
  process.exit(2);
}
// A fresh purchase ID per run, so one run's challenge (and any lockout) never affects the next.
const purchaseId = `voice-test-${Date.now()}`;
const challenge = voiceChallengeFromEnv(process.env);
if (challenge) {
  await challenge.register({ purchaseId, code });
  console.log("\nregistered the code with voice-verify, so the agent can check it live");
} else {
  console.log("\nVOICE_VERIFY_URL / VOICE_ADMIN_SECRET not set: the agent cannot check the code live; it is only compared after the call");
}
console.log(`\nONE-TIME CODE (read this out when the agent asks):  ${code}`);
console.log(`\nCalling now. Waiting up to ${timeoutSeconds}s for an answer...`);
try {
  const result = await new ElevenLabsOwnerCaller({ config }).call({
    purchaseId,
    summary,
    timeoutMs: timeoutSeconds * 1000,
  });
  console.log(`\nverbal result   ${result.verbal}`);
  console.log(`conversation id ${result.conversationId ?? "(none)"}`);
  console.log(`spoken code     ${result.spokenCode ?? "(none)"}  ->  ${codeMatches(result.spokenCode, code) ? "MATCHES" : "does NOT match"}`);
  if (result.verbal === "no_answer") {
    console.log("No clear yes or no was read back. Check the call transcript in ElevenLabs, and that the agent has a data-collection field with the name above.");
  }
} catch (error) {
  console.log(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
