import { randomInt, timingSafeEqual } from "node:crypto";
import { usdc } from "./explain.ts";
import type { VerityQuote } from "./quote.ts";
import type { PaymentStore } from "./store.ts";

/**
 * Voice-based spending approvals (large purchases only).
 *
 * Voice is the interface; the wallet signature is the authorization. The owner is called, hears what
 * Verity wants to buy, from whom, the price and why, and answers yes or no. A spoken yes is only
 * logged. It never releases funds: `PaymentStore.recordOwnerApproval` does that, and only for a valid
 * EIP-712 signature from the enrolled owner wallet. A no, silence, a failed call, or any answer
 * that is not a clear yes ends in denial (default on timeout is deny).
 */

export type VerbalResult = "yes" | "no" | "no_answer";

export interface OwnerCallResult {
  verbal: VerbalResult;
  conversationId: string | null;
  /** Digits the person on the call read back (the agent is never told the expected code). Null if none was captured. */
  spokenCode?: string | null;
}

/** A fresh 4-digit one-time code. */
export function generateApprovalCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}

/** Constant-time comparison of the digits the caller said against the expected code. */
export function codeMatches(spoken: string | null | undefined, expected: string): boolean {
  const digits = (spoken ?? "").replace(/\D/g, "");
  const a = Buffer.from(digits.padEnd(expected.length, "x").slice(0, expected.length));
  const b = Buffer.from(expected);
  return digits.length === expected.length && a.length === b.length && timingSafeEqual(a, b);
}

/** Calls the owner and reports what they said. Implementations must resolve within `timeoutMs`. */
export interface OwnerCaller {
  call(args: { purchaseId: string; summary: string; timeoutMs: number }): Promise<OwnerCallResult>;
}

export type VoiceApprovalOutcome =
  /** Owner agreed verbally. The purchase is still awaiting a wallet signature and cannot be signed. */
  | { outcome: "awaiting_signature"; conversationId: string | null }
  | { outcome: "denied"; conversationId: string | null }
  | { outcome: "timed_out"; conversationId: string | null };

/**
 * What the owner hears, kept to one short breath so it is hard to talk over: what, from whom, the price
 * and why. It ends in a statement. The agent's own prompt then asks the yes/no question and says that
 * nothing is authorized until the wallet signs.
 */
export function buildCallSummary(args: { quote: VerityQuote; contractId: string; evidenceType: string }): string {
  const { quote } = args;
  return (
    `Verity wants to buy ${quote.catalogItemId} from ${quote.merchantId} for ${usdc(quote.amount)} on testnet, ` +
    `to resolve the ${args.evidenceType.replaceAll("_", " ")} question on contract ${args.contractId}.`
  );
}

/**
 * Calls the owner for a purchase that is awaiting approval and records the outcome in the decision log.
 * Never stores an approval and never signs anything.
 */
export async function requestOwnerApproval(args: {
  store: PaymentStore;
  caller: OwnerCaller;
  purchaseId: string;
  quote: VerityQuote;
  timeoutMs: number;
  now: () => number;
  /**
   * Guards against a stranger answering the phone. When set, a one-time code is generated and shown to the
   * owner through `show` (a screen only the owner sees) BEFORE the call. The person on the call must read it back;
   * a spoken yes with a missing or wrong code is a denial. The code is never sent to the agent or stored.
   */
  codeCheck?: {
    show: (info: { purchaseId: string; code: string }) => void | Promise<void>;
    /** Registers the code for the agent's live check (see voiceChallenge.ts). If it throws, no call is placed. */
    register?: (info: { purchaseId: string; code: string }) => void | Promise<void>;
  };
}): Promise<VoiceApprovalOutcome> {
  const record = args.store.get(args.purchaseId);
  if (record?.status !== "awaiting_approval") throw new Error(`purchase ${args.purchaseId} is not awaiting owner approval`);
  const summary = buildCallSummary({
    quote: args.quote,
    contractId: record.request.parameters.contractId,
    evidenceType: record.request.parameters.evidenceType,
  });

  const code = args.codeCheck ? generateApprovalCode() : undefined;
  if (args.codeCheck && code) {
    if (args.codeCheck.register) {
      try {
        await args.codeCheck.register({ purchaseId: args.purchaseId, code });
      } catch (error) {
        // Fail closed: without a registered challenge the agent cannot check the code, so do not call.
        args.store.denyAwaitingApproval({
          purchaseId: args.purchaseId,
          outcome: "timed_out",
          channel: "voice_call",
          detail: `could not register the one-time code: ${error instanceof Error ? error.message : "failed"}`,
          now: args.now(),
        });
        return { outcome: "timed_out", conversationId: null };
      }
    }
    try {
      await args.codeCheck.show({ purchaseId: args.purchaseId, code });
    } catch (error) {
      // Fail closed: the owner never saw the code, so they cannot pass the check. Record it instead of throwing,
      // which would leave the purchase awaiting approval with a registered challenge and no decision.
      args.store.denyAwaitingApproval({
        purchaseId: args.purchaseId,
        outcome: "timed_out",
        channel: "voice_call",
        detail: `could not show the one-time code: ${error instanceof Error ? error.message : "failed"}`,
        now: args.now(),
      });
      return { outcome: "timed_out", conversationId: null };
    }
  }

  let result: OwnerCallResult;
  let failure: string | null = null;
  try {
    result = await args.caller.call({ purchaseId: args.purchaseId, summary, timeoutMs: args.timeoutMs });
  } catch (error) {
    failure = error instanceof Error ? error.message : "call failed";
    result = { verbal: "no_answer", conversationId: null };
  }

  if (result.verbal === "yes" && code && !codeMatches(result.spokenCode, code)) {
    args.store.denyAwaitingApproval({
      purchaseId: args.purchaseId,
      outcome: "denied",
      channel: "voice_call",
      conversationId: result.conversationId,
      detail: result.spokenCode ? "spoken one-time code did not match" : "no one-time code was given on the call",
      now: args.now(),
    });
    return { outcome: "denied", conversationId: result.conversationId };
  }
  if (result.verbal === "yes") {
    args.store.recordVerbalConsent({ purchaseId: args.purchaseId, conversationId: result.conversationId, now: args.now() });
    return { outcome: "awaiting_signature", conversationId: result.conversationId };
  }
  const outcome = result.verbal === "no" ? "denied" : "timed_out";
  args.store.denyAwaitingApproval({
    purchaseId: args.purchaseId,
    outcome,
    channel: "voice_call",
    conversationId: result.conversationId,
    detail: failure ?? (outcome === "denied" ? "owner declined on the call" : "no answer or no clear decision before the timeout"),
    now: args.now(),
  });
  return { outcome, conversationId: result.conversationId };
}

export interface ElevenLabsConfig {
  apiKey: string;
  agentId: string;
  /** ElevenLabs phone number the call comes from (Twilio / SIP trunk imported into the workspace). */
  agentPhoneNumberId: string;
  /** The enrolled owner's number. */
  ownerPhoneNumber: string;
  /** Name of the agent's data-collection field whose value is "yes" or "no". */
  decisionField?: string;
  /** Data-collection field holding the digits the person read back. Default "spoken_code". */
  codeField?: string;
  /** How the ElevenLabs phone number is connected. Selects the outbound-call endpoint. Default "twilio". */
  phoneProvider?: "twilio" | "sip_trunk";
  baseUrl?: string;
}

/** Reads the config from the environment, or undefined when any required value is missing. */
export function elevenLabsConfigFromEnv(env: Record<string, string | undefined>): ElevenLabsConfig | undefined {
  const apiKey = env.ELEVENLABS_API_KEY;
  const agentId = env.ELEVENLABS_AGENT_ID;
  const agentPhoneNumberId = env.ELEVENLABS_PHONE_NUMBER_ID;
  const ownerPhoneNumber = env.OWNER_PHONE_NUMBER;
  if (!apiKey || !agentId || !agentPhoneNumberId || !ownerPhoneNumber) return undefined;
  return {
    apiKey,
    agentId,
    agentPhoneNumberId,
    ownerPhoneNumber,
    ...(env.ELEVENLABS_DECISION_FIELD ? { decisionField: env.ELEVENLABS_DECISION_FIELD } : {}),
    ...(env.ELEVENLABS_CODE_FIELD ? { codeField: env.ELEVENLABS_CODE_FIELD } : {}),
    ...(env.ELEVENLABS_PHONE_PROVIDER === "sip_trunk" ? { phoneProvider: "sip_trunk" as const } : {}),
  };
}

/** A live caller when every ElevenLabs value is in the environment, otherwise undefined (no call is made). */
export function ownerCallerFromEnv(env: Record<string, string | undefined>): ElevenLabsOwnerCaller | undefined {
  const config = elevenLabsConfigFromEnv(env);
  return config ? new ElevenLabsOwnerCaller({ config }) : undefined;
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * ElevenLabs Conversational AI over its REST API. It places an outbound call with the purchase summary
 * as dynamic variables, then polls the conversation until it is done. The ElevenLabs agent must be
 * configured to read `{{purchase_summary}}`, ask for a clear yes or no, and store it in the data-collection
 * field named by `decisionField` (default `owner_decision`). Only the exact values "yes" and "no" count;
 * everything else, including a failed call, is treated as no answer.
 */
export class ElevenLabsOwnerCaller implements OwnerCaller {
  readonly #config: ElevenLabsConfig;
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #clock: () => number;
  readonly #pollMs: number;

  constructor(options: {
    config: ElevenLabsConfig;
    fetch?: Fetch;
    sleep?: (ms: number) => Promise<void>;
    /** Milliseconds clock. Injected so tests do not wait in real time. */
    clock?: () => number;
    pollMs?: number;
  }) {
    this.#config = options.config;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#clock = options.clock ?? Date.now;
    this.#pollMs = options.pollMs ?? 3000;
  }

  async call(args: { purchaseId: string; summary: string; timeoutMs: number }): Promise<OwnerCallResult> {
    const base = this.#config.baseUrl ?? "https://api.elevenlabs.io";
    const headers = { "xi-api-key": this.#config.apiKey, "content-type": "application/json" };
    const deadline = this.#clock() + args.timeoutMs;

    const endpoint = this.#config.phoneProvider === "sip_trunk" ? "sip-trunk" : "twilio";
    const started = await this.#fetch(`${base}/v1/convai/${endpoint}/outbound-call`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent_id: this.#config.agentId,
        agent_phone_number_id: this.#config.agentPhoneNumberId,
        to_number: this.#config.ownerPhoneNumber,
        conversation_initiation_client_data: {
          dynamic_variables: { purchase_id: args.purchaseId, purchase_summary: args.summary },
        },
      }),
    });
    if (!started.ok) throw new Error(`ElevenLabs outbound call failed with HTTP ${started.status}`);
    const startedBody = (await started.json()) as { success?: unknown; conversation_id?: unknown };
    const conversationId = typeof startedBody.conversation_id === "string" ? startedBody.conversation_id : null;
    if (startedBody.success === false || !conversationId) throw new Error("ElevenLabs did not start the call");

    const field = this.#config.decisionField ?? "owner_decision";
    while (this.#clock() < deadline) {
      await this.#sleep(Math.min(this.#pollMs, Math.max(0, deadline - this.#clock())));
      // A network error or bad body on one poll must not end the wait: the call is still live.
      let body: {
        status?: unknown;
        analysis?: { data_collection_results?: Record<string, { value?: unknown } | undefined> };
      };
      try {
        const response = await this.#fetch(`${base}/v1/convai/conversations/${encodeURIComponent(conversationId)}`, { headers });
        if (!response.ok) continue;
        body = (await response.json()) as typeof body;
      } catch {
        continue;
      }
      if (body.status === "failed") return { verbal: "no_answer", conversationId };
      if (body.status !== "done") continue;
      const value = body.analysis?.data_collection_results?.[field]?.value;
      const verbal = typeof value === "string" ? value.trim().toLowerCase() : "";
      const rawCode = body.analysis?.data_collection_results?.[this.#config.codeField ?? "spoken_code"]?.value;
      const spokenCode = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : null;
      return { verbal: verbal === "yes" ? "yes" : verbal === "no" ? "no" : "no_answer", conversationId, spokenCode };
    }
    return { verbal: "no_answer", conversationId };
  }
}
