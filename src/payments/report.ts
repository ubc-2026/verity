import type { Hex } from "viem";
import type { DeliveryReceiptV1 } from "./receipt.ts";
import type { VerifyResult } from "./merchant.ts";

export interface Check {
  ok: boolean;
  detail?: string;
}

export interface VerificationChecks {
  requestHash: Check;
  amount: Check;
  merchant: Check;
  authorization: Check;
  nonce: Check;
  resource: Check;
}

export interface VerificationReport {
  outcome: "verified" | "rejected";
  reason: string | null;
  checks: VerificationChecks;
  requestHash: Hex | null;
  nonce: Hex | null;
  delivery: null | {
    resourceId: string;
    contentHash: Hex;
    contentType: string;
    body: string;
    receipt: DeliveryReceiptV1;
    receiptSignature: Hex;
  };
  simulation?: "wrong-resource" | "changed-url" | "duplicate";
}

const passed: Check = { ok: true };
const pending = (detail: string): Check => ({ ok: false, detail });

function blankChecks(detail = "not reached"): VerificationChecks {
  return {
    requestHash: pending(detail),
    amount: pending(detail),
    merchant: pending(detail),
    authorization: pending(detail),
    nonce: pending(detail),
    resource: pending(detail),
  };
}

function allPassed(): VerificationChecks {
  return {
    requestHash: passed,
    amount: passed,
    merchant: passed,
    authorization: passed,
    nonce: passed,
    resource: passed,
  };
}

function rejected(reason: string, checks: VerificationChecks): VerificationReport {
  return { outcome: "rejected", reason, checks, requestHash: null, nonce: null, delivery: null };
}

/**
 * Maps a fail-closed verifier result onto the six checks. A check is `ok`
 * only when `verifyPaidRequest` has already passed it.
 */
export function classifyVerifyFailure(result: Extract<VerifyResult, { ok: false }>): VerificationReport {
  const { reason } = result;
  const checks = blankChecks();
  const requestPassed = () => {
    checks.requestHash = passed;
  };
  const paymentTargetPassed = () => {
    requestPassed();
    checks.merchant = passed;
    checks.amount = passed;
  };

  if (reason.includes("amount")) {
    requestPassed();
    checks.merchant = passed;
    checks.amount = { ok: false, detail: reason };
    return rejected("amount_mismatch", checks);
  }
  if (
    reason.includes("recipient") ||
    reason.includes("another merchant") ||
    reason.includes("token") ||
    reason.includes("network")
  ) {
    requestPassed();
    checks.merchant = { ok: false, detail: reason };
    return rejected("merchant_mismatch", checks);
  }
  if (reason.includes("nonce")) {
    paymentTargetPassed();
    checks.nonce = { ok: false, detail: reason };
    checks.requestHash = { ok: false, detail: reason };
    return rejected("request_hash_mismatch", checks);
  }
  if (
    reason.includes("signature") ||
    reason.includes("payer") ||
    reason.includes("validity") ||
    reason.includes("window") ||
    reason.includes("expired") ||
    reason.includes("outlives")
  ) {
    paymentTargetPassed();
    if (reason.includes("signature") || reason.includes("payer")) checks.nonce = passed;
    checks.authorization = { ok: false, detail: reason };
    return rejected("invalid_authorization", checks);
  }
  if (reason.includes("artifact")) {
    paymentTargetPassed();
    checks.nonce = passed;
    checks.authorization = passed;
    checks.resource = { ok: false, detail: reason };
    return rejected("wrong_resource", checks);
  }

  checks.requestHash = { ok: false, detail: reason };
  return rejected(reason, checks);
}

export function reportNonceReplay(): VerificationReport {
  const checks = allPassed();
  checks.nonce = { ok: false, detail: "authorization nonce was already accepted" };
  checks.resource = pending("not reached");
  return rejected("nonce_replay", checks);
}

export function reportWrongResource(detail: string): VerificationReport {
  const checks = allPassed();
  checks.resource = { ok: false, detail };
  return rejected("wrong_resource", checks);
}

export function reportVerified(input: {
  requestHash: Hex;
  nonce: Hex;
  resourceId: string;
  contentType: string;
  body: string;
  contentHash: Hex;
  receipt: DeliveryReceiptV1;
  receiptSignature: Hex;
}): VerificationReport {
  return {
    outcome: "verified",
    reason: null,
    checks: allPassed(),
    requestHash: input.requestHash,
    nonce: input.nonce,
    delivery: {
      resourceId: input.resourceId,
      contentHash: input.contentHash,
      contentType: input.contentType,
      body: input.body,
      receipt: input.receipt,
      receiptSignature: input.receiptSignature,
    },
  };
}
