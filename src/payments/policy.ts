import { getAddress, type Hex } from "viem";
import { fromBaseUnits } from "./researchRequest.ts";

/** 25 USDC mission budget, in 6-decimal base units. */
export const MISSION_BUDGET = 25_000_000n;
/** Local placeholder. This is not the USDC contract. */
export const POLICY_CONTRACT: Hex = getAddress("0x0000000000000000000000000000000000000001");

const AUTO_MIN = 10_000n;
const AUTO_MAX = 100_000n;
const GAP_MAX = 500_000n;
const APPROVAL_MAX = 2_000_000n;

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
  | { decision: "allow"; tier: "auto" | "gap" }
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

interface Hold {
  amount: bigint;
  state: "reserved" | "spent";
}

/**
 * In-memory mission budget. Reserved and spent holds both count toward the
 * 25 USDC cap. One group key (contract + evidence gap) can be held once.
 */
export class MissionBudget {
  readonly #holds = new Map<string, Hold>();
  readonly #budget: bigint;

  constructor(budget: bigint = MISSION_BUDGET) {
    this.#budget = budget;
  }

  get budget(): bigint {
    return this.#budget;
  }

  committed(): bigint {
    let total = 0n;
    for (const hold of this.#holds.values()) total += hold.amount;
    return total;
  }

  keys(state: Hold["state"]): string[] {
    return [...this.#holds.entries()].filter(([, hold]) => hold.state === state).map(([key]) => key);
  }

  hold(groupKey: string, amount: bigint): void {
    if (this.#holds.has(groupKey)) throw new Error(`group already held: ${groupKey}`);
    if (this.committed() + amount > this.#budget) throw new Error("mission budget exceeded");
    this.#holds.set(groupKey, { amount, state: "reserved" });
  }

  release(groupKey: string): void {
    const hold = this.#holds.get(groupKey);
    if (!hold || hold.state !== "reserved") throw new Error(`no reservation to release: ${groupKey}`);
    this.#holds.delete(groupKey);
  }

  confirm(groupKey: string): void {
    const hold = this.#holds.get(groupKey);
    if (!hold || hold.state !== "reserved") throw new Error(`no reservation to confirm: ${groupKey}`);
    hold.state = "spent";
  }
}
