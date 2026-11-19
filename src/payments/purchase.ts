import { recoverTypedDataAddress, type Hex } from "viem";
import {
  buildResearchRequest,
  InMemoryAuthorizationStore,
  prepareAuthorization,
  type CatalogItem,
  type PreparedAuthorization,
  type ProposalSelection,
} from "./buyer.ts";
import type { VerityQuote } from "./quote.ts";
import {
  assessPolicy,
  MissionBudget,
  ownerApprovalDomain,
  ownerApprovalTypes,
  parseQuoteAmount,
  type OwnerApprovalMessage,
  type PolicyDecision,
} from "./policy.ts";
import { computeRequestHash, type ResearchRequestV1 } from "./researchRequest.ts";

export interface PurchaseInput {
  selection: ProposalSelection;
  groupKey: string;
  quote: VerityQuote;
  payer: Hex;
  now: number;
  materialUnresolvedGap: boolean;
  ownerSignature?: Hex;
}

export type PurchaseResult =
  | { status: "rejected"; decision: Extract<PolicyDecision, { decision: "reject" }> }
  | {
      status: "awaiting_approval";
      decision: Extract<PolicyDecision, { decision: "needs_approval" }>;
      request: ResearchRequestV1;
      requestHash: Hex;
    }
  | {
      status: "ready";
      decision: PolicyDecision;
      request: ResearchRequestV1;
      prepared: PreparedAuthorization;
    };

function approvalMessage(request: ResearchRequestV1, requestHash: Hex): OwnerApprovalMessage {
  return {
    purchaseId: request.purchaseId,
    requestHash,
    amount: BigInt(request.amount),
    payTo: request.payTo,
    expiry: BigInt(request.validBefore),
  };
}

export function approvalTypedData(request: ResearchRequestV1, requestHash: Hex) {
  return {
    domain: ownerApprovalDomain(request.chainId),
    types: ownerApprovalTypes,
    primaryType: "OwnerApproval" as const,
    message: approvalMessage(request, requestHash),
  };
}

/**
 * Payment service. It reserves the mission budget, and it creates an EIP-3009
 * authorization only after policy passes. Owner approval is a signature over
 * the request hash. A missing signature leaves the reservation outstanding.
 */
export class PaymentService {
  readonly budget: MissionBudget;
  readonly authorizations = new InMemoryAuthorizationStore();
  readonly #catalog: ReadonlyMap<string, CatalogItem>;
  readonly #owner: Hex;
  readonly #pending = new Map<string, ResearchRequestV1>();
  readonly #usedApprovals = new Set<string>();
  #paused = false;

  constructor(options: { catalog: ReadonlyMap<string, CatalogItem>; owner: Hex; budget?: bigint }) {
    this.#catalog = options.catalog;
    this.#owner = options.owner;
    this.budget = new MissionBudget(options.budget);
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  confirm(groupKey: string): void {
    this.budget.confirm(groupKey);
    this.#pending.delete(groupKey);
  }

  release(groupKey: string): void {
    if (this.budget.keys("reserved").includes(groupKey)) this.budget.release(groupKey);
    this.#pending.delete(groupKey);
  }

  async begin(input: PurchaseInput): Promise<PurchaseResult> {
    const pending = this.#pending.get(input.groupKey);
    if (pending) return this.#finishApproval(input, pending);

    const decision = assessPolicy({
      amount: parseQuoteAmount(input.quote.amount),
      now: input.now,
      expiresAt: input.quote.expiresAt,
      merchantId: input.quote.merchantId,
      catalogItemId: input.quote.catalogItemId,
      groupKey: input.groupKey,
      materialUnresolvedGap: input.materialUnresolvedGap,
      paused: this.#paused,
      allowlistedMerchants: [...new Set([...this.#catalog.values()].map((item) => item.merchantId))],
      allowlistedItems: [...this.#catalog.keys()],
      reservedKeys: this.budget.keys("reserved"),
      spentKeys: this.budget.keys("spent"),
      committedBaseUnits: this.budget.committed(),
      budget: this.budget.budget,
    });
    if (decision.decision === "reject") return { status: "rejected", decision };

    const request = buildResearchRequest({
      catalog: this.#catalog,
      proposal: input.selection,
      quote: input.quote,
      payer: input.payer,
      now: input.now,
    });

    if (decision.decision === "needs_approval" && !input.ownerSignature) {
      this.budget.hold(input.groupKey, parseQuoteAmount(input.quote.amount));
      this.#pending.set(input.groupKey, request);
      return { status: "awaiting_approval", decision, request, requestHash: computeRequestHash(request) };
    }

    if (decision.decision === "needs_approval") {
      const approved = await this.#ownerSigned(input, request);
      if (!approved.ok) return { status: "rejected", decision: { decision: "reject", reason: approved.reason } };
    }

    this.budget.hold(input.groupKey, parseQuoteAmount(input.quote.amount));
    return {
      status: "ready",
      decision,
      request,
      prepared: prepareAuthorization(request, this.authorizations),
    };
  }

  async #finishApproval(input: PurchaseInput, request: ResearchRequestV1): Promise<PurchaseResult> {
    const decision = { decision: "needs_approval", tier: "owner" } as const;
    if (!input.ownerSignature) {
      return { status: "awaiting_approval", decision, request, requestHash: computeRequestHash(request) };
    }
    const approved = await this.#ownerSigned(input, request);
    if (!approved.ok) return { status: "rejected", decision: { decision: "reject", reason: approved.reason } };
    this.#pending.delete(input.groupKey);
    return {
      status: "ready",
      decision,
      request,
      prepared: prepareAuthorization(request, this.authorizations),
    };
  }

  async #ownerSigned(input: PurchaseInput, request: ResearchRequestV1): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.#usedApprovals.has(request.purchaseId)) {
      return { ok: false, reason: "owner approval was already used" };
    }
    if (input.now >= request.validBefore) return { ok: false, reason: "owner approval expired" };
    const requestHash = computeRequestHash(request);
    const signature = input.ownerSignature;
    if (!signature) return { ok: false, reason: "owner signature is required" };
    const signer = await recoverTypedDataAddress({
      ...approvalTypedData(request, requestHash),
      signature,
    }).catch(() => undefined);
    if (!signer || signer.toLowerCase() !== this.#owner.toLowerCase()) {
      return { ok: false, reason: "owner signature does not match the enrolled wallet" };
    }
    this.#usedApprovals.add(request.purchaseId);
    return { ok: true };
  }
}
