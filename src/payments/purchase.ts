import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { buildResearchRequest, type CatalogItem } from "./buyer.ts";
import { GATEWAY_AUTH_VALIDITY_SECONDS } from "./circleGateway.ts";
import { explainDecision, type DecisionExplanation } from "./explain.ts";
import { authorizeStoredPurchase, type AuthorizedPayment, type PaymentSigner } from "./paymentService.ts";
import { approvalTypedData, assessPolicy, parseQuoteAmount, type PolicyDecision } from "./policy.ts";
import type { AcceptedProposal } from "./proposal.ts";
import type { VerityQuote } from "./quote.ts";
import { ResearchRequestError, type ResearchRequestV1 } from "./researchRequest.ts";
import { PolicyError, type PaymentStore } from "./store.ts";
import { requestOwnerApproval, type OwnerCaller } from "./voiceApproval.ts";

/** Buyer-generated purchase ID, sent with the quote request. The quote must echo it. */
export function newPurchaseId(): string {
  return `purchase-${randomBytes(12).toString("hex")}`;
}

export type PurchaseResult =
  | { status: "rejected"; reason: string; decision: PolicyDecision | null; explanation: DecisionExplanation }
  | {
      status: "awaiting_approval";
      decision: Extract<PolicyDecision, { decision: "needs_approval" }>;
      request: ResearchRequestV1;
      requestHash: Hex;
      /** EIP-712 payload the owner wallet must sign before anything is authorized. */
      approval: ReturnType<typeof approvalTypedData>;
      explanation: DecisionExplanation;
    }
  | {
      status: "authorized";
      decision: PolicyDecision;
      request: ResearchRequestV1;
      payment: AuthorizedPayment;
      explanation: DecisionExplanation;
    };

/**
 * Buyer side of a purchase. Policy is decided from durable state, the budget is
 * reserved and the request, salt, and nonce recorded in one transaction, and
 * the EIP-3009 authorization is signed only from that stored record. A purchase
 * above the gap tier stays `awaiting_approval` and cannot be signed until a
 * valid owner signature is stored.
 */
export class BuyerService {
  readonly #store: PaymentStore;
  readonly #catalog: ReadonlyMap<string, CatalogItem>;
  readonly #owner: Hex;
  readonly #signer: PaymentSigner;
  readonly #tokenDomain: { name: string; version: string };
  readonly #missionId: string;
  readonly #saltSource: (() => Hex) | undefined;
  readonly #ownerCaller: OwnerCaller | undefined;
  readonly #voiceTimeoutMs: number;
  readonly #ownerCodeDisplay: ((info: { purchaseId: string; code: string }) => void | Promise<void>) | undefined;
  readonly #ownerCodeRegister: ((info: { purchaseId: string; code: string }) => void | Promise<void>) | undefined;

  constructor(options: {
    store: PaymentStore;
    catalog: ReadonlyMap<string, CatalogItem>;
    owner: Hex;
    signer: PaymentSigner;
    tokenDomain: { name: string; version: string };
    missionId: string;
    /** Fixture runs pass a deterministic salt source; production leaves the CSPRNG default. */
    saltSource?: () => Hex;
    /** Live voice call to the owner for tier 3 purchases. Absent: the owner is only given the explanation text. */
    ownerCaller?: OwnerCaller;
    /** Shows the one-time code to the owner (a screen only they see) before the call. Enables the spoken-code check. */
    ownerCodeDisplay?: (info: { purchaseId: string; code: string }) => void | Promise<void>;
    /** Registers each code with the voice-verify Worker so the agent can check it live (voiceChallengeFromEnv). */
    ownerCodeRegister?: (info: { purchaseId: string; code: string }) => void | Promise<void>;
    /** How long to wait for the owner's spoken answer. Default 2 minutes. */
    voiceTimeoutMs?: number;
  }) {
    this.#store = options.store;
    this.#catalog = options.catalog;
    this.#owner = options.owner;
    this.#signer = options.signer;
    this.#tokenDomain = options.tokenDomain;
    this.#missionId = options.missionId;
    this.#saltSource = options.saltSource;
    this.#ownerCaller = options.ownerCaller;
    this.#voiceTimeoutMs = options.voiceTimeoutMs ?? 120_000;
    this.#ownerCodeDisplay = options.ownerCodeDisplay;
    this.#ownerCodeRegister = options.ownerCodeRegister;
  }

  /** The pause switch is durable (PaymentStore), so it holds across restarts and for purchases already reserved. */
  pause(now: number = Math.floor(Date.now() / 1000), reason: string | null = null): void {
    this.#store.setPaused(true, now, reason);
  }

  resume(now: number = Math.floor(Date.now() / 1000)): void {
    this.#store.setPaused(false, now);
  }

  get paused(): boolean {
    return this.#store.isPaused();
  }

  /** Budget for this buyer's mission, counting held reservations and settled spend. */
  budget() {
    return this.#store.budget(this.#missionId);
  }

  /**
   * The owner declines a purchase that is awaiting approval. The reservation is
   * released; the purchase can never be signed afterwards.
   */
  rejectApproval(input: { purchaseId: string; reason: string; now: number; quote: VerityQuote }): PurchaseResult {
    this.#store.recordOwnerRejection(input);
    const decision = { decision: "reject", reason: `owner rejected: ${input.reason}` } as const;
    return { status: "rejected", reason: decision.reason, decision, explanation: explainDecision({ decision, quote: input.quote }) };
  }

  async purchase(input: {
    accepted: AcceptedProposal;
    purchaseId: string;
    quote: VerityQuote;
    now: number;
    ownerSignature?: Hex;
  }): Promise<PurchaseResult> {
    const { accepted, purchaseId, quote, now } = input;
    const existing = this.#store.get(purchaseId);
    if (existing) return this.#continue(existing.request, input);

    const amount = parseQuoteAmount(quote.amount);
    const rail = this.#catalog.get(accepted.selection.catalogItemId)?.rail ?? "arc-eip3009";
    const decision = assessPolicy({
      rail,
      amount,
      now,
      expiresAt: quote.expiresAt,
      merchantId: quote.merchantId,
      catalogItemId: quote.catalogItemId,
      groupKey: accepted.groupKey,
      materialUnresolvedGap: accepted.materialUnresolvedGap,
      paused: this.#store.isPaused(),
      allowlistedMerchants: [...new Set([...this.#catalog.values()].map((item) => item.merchantId))],
      allowlistedItems: [...this.#catalog.keys()],
      // Duplicates are enforced durably by PaymentStore (one purchase per mission, contract, and evidence type).
      reservedKeys: [],
      spentKeys: [],
      committedBaseUnits: this.#store.committedSpend(this.#missionId),
      budget: this.#store.policy.missionBudget,
    });
    if (decision.decision === "reject") {
      return { status: "rejected", reason: decision.reason, decision, explanation: explainDecision({ decision, quote }) };
    }

    let request: ResearchRequestV1;
    try {
      request = buildResearchRequest({
        catalog: this.#catalog,
        proposal: accepted.selection,
        quote,
        purchaseId,
        catalogParameters: accepted.catalogParameters,
        payer: this.#signer.address,
        now,
        // Circle requires Gateway authorizations valid for 7 days; the merchant still refuses an expired quote.
        ...(rail === "circle-gateway-batched" ? { windowSeconds: GATEWAY_AUTH_VALIDITY_SECONDS, allowBeyondQuoteExpiry: true } : {}),
      });
      this.#store.reserveAndRecord({
        missionId: this.#missionId,
        request,
        now,
        materialUnresolvedGap: accepted.materialUnresolvedGap,
        rail,
        ...(this.#saltSource ? { saltSource: this.#saltSource } : {}),
      });
    } catch (error) {
      if (!(error instanceof PolicyError || error instanceof ResearchRequestError)) throw error;
      const rejected = { decision: "reject", reason: error.message } as const;
      return { status: "rejected", reason: error.message, decision: rejected, explanation: explainDecision({ decision: rejected, quote }) };
    }
    return this.#continue(request, input, decision);
  }

  async #continue(
    request: ResearchRequestV1,
    input: { purchaseId: string; quote: VerityQuote; now: number; ownerSignature?: Hex },
    decision?: PolicyDecision,
  ): Promise<PurchaseResult> {
    let record = this.#store.get(input.purchaseId)!;
    const refuse = (reason: string): PurchaseResult => {
      const rejected = { decision: "reject", reason } as const;
      return { status: "rejected", reason, decision: rejected, explanation: explainDecision({ decision: rejected, quote: input.quote }) };
    };
    // A resumed purchase passes the same gates as a new one: pause, closed records, and an expired window.
    if (this.#store.isPaused()) return refuse("payments are paused");
    if (record.status === "rejected" || record.status === "denied") return refuse("the owner rejected this purchase");
    if (record.status === "expired") return refuse("the authorization window expired before signing");
    if (record.signature === null && input.now >= record.request.validBefore) {
      this.#store.expire(input.purchaseId, input.now);
      return refuse("the authorization window expired before signing");
    }
    const amount = BigInt(request.amount);
    const limits = this.#store.policy;
    const effective: PolicyDecision =
      decision ??
      (record.rail === "circle-gateway-batched"
        ? { decision: "allow", tier: "nanopayment" }
        : amount > limits.gapMax
        ? { decision: "needs_approval", tier: "owner" }
        : { decision: "allow", tier: amount > limits.autoApproveMax ? "gap" : "auto" });

    if (record.status === "awaiting_approval") {
      const waiting = { decision: "needs_approval", tier: "owner" } as const;
      // Call the owner once per purchase. A spoken yes is logged only; the wallet signature below is what authorizes.
      if (this.#ownerCaller && this.#store.approvalDecisions(input.purchaseId).length === 0) {
        const voice = await requestOwnerApproval({
          store: this.#store,
          caller: this.#ownerCaller,
          purchaseId: input.purchaseId,
          quote: input.quote,
          timeoutMs: this.#voiceTimeoutMs,
          now: () => input.now,
          ...(this.#ownerCodeDisplay
            ? { codeCheck: { show: this.#ownerCodeDisplay, ...(this.#ownerCodeRegister ? { register: this.#ownerCodeRegister } : {}) } }
            : {}),
        });
        if (voice.outcome !== "awaiting_signature") {
          const rejected = { decision: "reject", reason: voice.outcome === "denied" ? "owner declined the purchase" : "owner did not approve in time" } as const;
          return { status: "rejected", reason: rejected.reason, decision: rejected, explanation: explainDecision({ decision: rejected, quote: input.quote }) };
        }
      }
      if (!input.ownerSignature) {
        return {
          status: "awaiting_approval",
          decision: waiting,
          request,
          requestHash: record.requestHash,
          approval: approvalTypedData(request, record.requestHash),
          explanation: explainDecision({ decision: waiting, quote: input.quote }),
        };
      }
      try {
        record = await this.#store.recordOwnerApproval({
          purchaseId: input.purchaseId,
          signature: input.ownerSignature,
          owner: this.#owner,
          now: input.now,
        });
      } catch (error) {
        if (!(error instanceof PolicyError)) throw error;
        const rejected = { decision: "reject", reason: error.message } as const;
        return { status: "rejected", reason: error.message, decision: rejected, explanation: explainDecision({ decision: rejected, quote: input.quote }) };
      }
    }

    const payment = await authorizeStoredPurchase({
      store: this.#store,
      purchaseId: input.purchaseId,
      signer: this.#signer,
      tokenDomain: this.#tokenDomain,
      now: input.now,
    });
    return {
      status: "authorized",
      decision: effective,
      request: payment.record.request,
      payment,
      explanation: explainDecision({ decision: effective, quote: input.quote, ownerApproved: input.ownerSignature !== undefined }),
    };
  }
}
