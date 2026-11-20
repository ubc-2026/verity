import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import { fromBaseUnits, type ResearchRequestV1 } from "./researchRequest.ts";

/** 25 USDC mission budget, in 6-decimal base units. */
export const MISSION_BUDGET = 25_000_000n;
/** Local placeholder. This is not the USDC contract. */
export const POLICY_CONTRACT: Hex = getAddress("0x0000000000000000000000000000000000000001");

/** Tier limits from the README, in USDC base units. PaymentStore enforces the same numbers. */
export const AUTO_MIN = 10_000n;
export const AUTO_MAX = 100_000n;
export const GAP_MAX = 500_000n;
export const APPROVAL_MAX = 2_000_000n;

/**
 * Explicit nanopayment policy (Circle Gateway rail only). Amounts under the 0.01 USDC
 * minimum are allowed only here: allowlisted items, at most 0.001 USDC each, and only
 * for a material unresolved gap. Mission budget and duplicate checks still apply.
 */
export const NANOPAYMENT_POLICY = {
  rail: "circle-gateway-batched",
  minAmount: 1n,
  maxAmount: 1_000n, // 0.001 USDC
  allowlistedItems: ["cat-nws-cli-settlement-version-nano-v1"] as readonly string[],
} as const;

export const ownerApprovalTypes = {
  OwnerApproval: [
    { name: "purchaseId", type: "string" },
    { name: "requestHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

export interface OwnerApprovalMessage {
  purchaseId: string;
  requestHash: Hex;
  amount: bigint;
  payTo: Hex;
  expiry: bigint;
}

export function ownerApprovalDomain(chainId: number) {
  return { name: "Verity Owner Approval", version: "1", chainId, verifyingContract: POLICY_CONTRACT } as const;
}

export type PolicyDecision =
  | { decision: "allow"; tier: "auto" | "gap" | "nanopayment" }
  | { decision: "needs_approval"; tier: "owner" }
  | { decision: "reject"; reason: string };

export interface PolicyAssessmentInput {
  amount: bigint;
  now: number;
  expiresAt: number;
  merchantId: string;
  catalogItemId: string;
  groupKey: string;
  /** True when the analyst left a material resolution gap with no free or cached evidence. */
  materialUnresolvedGap: boolean;
  paused: boolean;
  allowlistedMerchants: readonly string[];
  allowlistedItems: readonly string[];
  reservedKeys: readonly string[];
  spentKeys: readonly string[];
  committedBaseUnits: bigint;
  budget: bigint;
  /** Payment rail of the catalog item. Defaults to the direct EIP-3009 rail. */
  rail?: "arc-eip3009" | "circle-gateway-batched";
}

/**
 * Pure spending rules from the README. Reservations and approval signatures
 * are applied by the caller; this function only decides.
 */
export function assessPolicy(input: PolicyAssessmentInput): PolicyDecision {
  if (input.paused) return { decision: "reject", reason: "payments are paused" };
  if (input.expiresAt <= input.now) return { decision: "reject", reason: "quote expired" };
  if (!input.allowlistedMerchants.includes(input.merchantId)) {
    return { decision: "reject", reason: "merchant is not allowlisted" };
  }
  if (!input.allowlistedItems.includes(input.catalogItemId)) {
    return { decision: "reject", reason: "catalog item is not allowlisted" };
  }
  if (input.reservedKeys.includes(input.groupKey) || input.spentKeys.includes(input.groupKey)) {
    return { decision: "reject", reason: "duplicate purchase for this contract and evidence gap" };
  }

  const { amount } = input;
  if (input.rail === NANOPAYMENT_POLICY.rail) {
    if (!NANOPAYMENT_POLICY.allowlistedItems.includes(input.catalogItemId)) {
      return { decision: "reject", reason: "catalog item is not allowlisted for nanopayments" };
    }
    if (amount < NANOPAYMENT_POLICY.minAmount || amount > NANOPAYMENT_POLICY.maxAmount) {
      return { decision: "reject", reason: "nanopayments are limited to 0.001 USDC per purchase" };
    }
    if (!input.materialUnresolvedGap) {
      return { decision: "reject", reason: "nanopayments require a material unresolved gap with no free or cached evidence" };
    }
    if (input.committedBaseUnits + amount > input.budget) return { decision: "reject", reason: "mission budget exceeded" };
    return { decision: "allow", tier: "nanopayment" };
  }
  if (amount < AUTO_MIN) return { decision: "reject", reason: "below the 0.01 USDC minimum" };
  if (amount > APPROVAL_MAX) return { decision: "reject", reason: "above the 2.00 USDC owner-approval maximum" };
  if (input.committedBaseUnits + amount > input.budget) {
    return { decision: "reject", reason: "mission budget exceeded" };
  }

  if (amount <= AUTO_MAX) return { decision: "allow", tier: "auto" };
  if (amount <= GAP_MAX) {
    if (!input.materialUnresolvedGap) {
      return { decision: "reject", reason: "this tier requires a material unresolved gap with no free or cached evidence" };
    }
    return { decision: "allow", tier: "gap" };
  }
  return { decision: "needs_approval", tier: "owner" };
}

export function parseQuoteAmount(amount: string): bigint {
  return fromBaseUnits(amount);
}

function approvalMessage(request: ResearchRequestV1, requestHash: Hex): OwnerApprovalMessage {
  return {
    purchaseId: request.purchaseId,
    requestHash,
    amount: BigInt(request.amount),
    payTo: request.payTo,
    expiry: BigInt(request.validBefore),
  };
}

/** EIP-712 payload the owner signs. It binds the purchase, the exact request, the amount, and the recipient. */
export function approvalTypedData(request: ResearchRequestV1, requestHash: Hex) {
  return {
    domain: ownerApprovalDomain(request.chainId),
    types: ownerApprovalTypes,
    primaryType: "OwnerApproval" as const,
    message: approvalMessage(request, requestHash),
  };
}

/** Checks an owner approval signature against the enrolled owner wallet. */
export async function verifyOwnerApproval(args: {
  request: ResearchRequestV1;
  requestHash: Hex;
  signature: Hex;
  owner: Hex;
  now: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (args.now >= args.request.validBefore) return { ok: false, reason: "owner approval expired" };
  const signer = await recoverTypedDataAddress({
    ...approvalTypedData(args.request, args.requestHash),
    signature: args.signature,
  }).catch(() => undefined);
  if (!signer || signer.toLowerCase() !== args.owner.toLowerCase()) {
    return { ok: false, reason: "owner signature does not match the enrolled wallet" };
  }
  return { ok: true };
}
