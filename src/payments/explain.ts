import type { PolicyDecision } from "./policy.ts";
import type { VerityQuote } from "./quote.ts";

/**
 * The spoken explanation of a spending decision. The text is built here from
 * the policy decision and the quote; a voice provider only reads it aloud.
 * `voice` records whether audio was produced. The fixture workflow never calls
 * ElevenLabs, so audio is always null there.
 */
export interface DecisionExplanation {
  provider: "elevenlabs";
  text: string;
  voice: { mode: "not_requested" | "fixture" | "live"; audio: null | { contentType: string; bytes: number } };
}

/** Text-to-speech seam. A live ElevenLabs client is not wired in this repository. */
export interface VoiceExplainer {
  speak(text: string): Promise<DecisionExplanation["voice"]>;
}

/** Records that an explanation would be spoken, without calling any service. */
export const fixtureVoice: VoiceExplainer = {
  async speak() {
    return { mode: "fixture", audio: null };
  },
};

export function usdc(baseUnits: string): string {
  const value = BigInt(baseUnits);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction.padEnd(2, "0")}` : ".00"} USDC`;
}

export function explainDecision(args: { decision: PolicyDecision; quote: VerityQuote; ownerApproved?: boolean }): DecisionExplanation {
  const { decision, quote } = args;
  const what = `${quote.catalogItemId} from ${quote.merchantId} for ${usdc(quote.amount)} (testnet)`;
  let text: string;
  switch (decision.decision) {
    case "reject":
      text = `Verity did not buy ${what}. Reason: ${decision.reason}. No payment was authorized.`;
      break;
    case "needs_approval":
      text =
        args.ownerApproved === true
          ? `The owner wallet approved ${what}. Verity authorized the payment for this one request.`
          : `Verity wants to buy ${what}. This amount needs your wallet signature. Nothing is authorized until you sign.`;
      break;
    case "allow":
      text =
        decision.tier === "auto"
          ? `Verity bought ${what} automatically: it is within the 0.10 USDC auto-approve tier.`
          : decision.tier === "nanopayment"
            ? `Verity bought ${what} as a Circle Gateway nanopayment: an allowlisted item, at most 0.001 USDC, for an open settlement question.`
            : `Verity bought ${what} under the evidence-gap tier: a material settlement question remained after free sources.`;
      break;
  }
  return { provider: "elevenlabs", text, voice: { mode: "not_requested", audio: null } };
}
