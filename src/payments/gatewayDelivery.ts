import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { parseBindingHeader } from "./binding.ts";
import { RECEIPT_HEADER } from "./deliveryReceipt.ts";
import {
  gatewayPaymentPayload,
  gatewayRequirements,
  isDeterministicGatewayRejection,
  type GatewayProvider,
  type GatewayTransfer,
} from "./circleGateway.ts";
import {
  encodeGatewayReceiptHeader,
  signGatewayReceipt,
  signedGatewayReceiptSchema,
  type GatewayReceiptSigner,
  type SignedGatewayReceipt,
} from "./gatewayReceipt.ts";
import { verifyPaidRequest, type MerchantDeps, type PaidRequest, type VerifyResult } from "./merchant.ts";
import { hashContent } from "./researchRequest.ts";

type Verified = Extract<VerifyResult, { ok: true }>;

/**
 * claimed    verified and claimed; Gateway not yet known to have accepted it.
 *            A retry reconciles by the original EIP-3009 nonce and does not settle again.
 * accepted   Gateway accepted the payment; the per-payment transfer may not be visible yet
 * delivered  receipt signed with the Gateway transfer ID and stored; retries replay it
 *
 * Batch settlement is tracked separately (batch_status / batch_tx_hash): Gateway
 * accepts a payment immediately and settles it later inside a batch transaction.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_deliveries (
  purchase_id         TEXT PRIMARY KEY,
  request_hash        TEXT NOT NULL,
  nonce               TEXT NOT NULL UNIQUE,
  verified_at         INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('claimed', 'accepted', 'delivered')),
  settle_transaction  TEXT,
  payment_ref         TEXT UNIQUE,
  batch_status        TEXT,
  batch_tx_hash       TEXT,
  receipt_json        TEXT,
  updated_at          INTEGER NOT NULL,
  CHECK ((status = 'delivered') = (receipt_json IS NOT NULL)),
  CHECK (status = 'claimed' OR settle_transaction IS NOT NULL)
) STRICT;
`;

export interface GatewayDeliveryRecord {
  purchaseId: string;
  requestHash: Hex;
  nonce: Hex;
  verifiedAt: number;
  status: "claimed" | "accepted" | "delivered";
  settleTransaction: string | null;
  paymentRef: string | null;
  batchStatus: string | null;
  batchTxHash: string | null;
  receipt: SignedGatewayReceipt | null;
}

export class GatewayDeliveryStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
  }
  close() {
    this.#db.close();
  }
  get(purchaseId: string): GatewayDeliveryRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM gateway_deliveries WHERE purchase_id = ?`).get(purchaseId) as
      | Record<string, string | number | null>
      | undefined;
    if (!row) return undefined;
    return {
      purchaseId: row.purchase_id as string,
      requestHash: row.request_hash as Hex,
      nonce: row.nonce as Hex,
      verifiedAt: row.verified_at as number,
      status: row.status as GatewayDeliveryRecord["status"],
      settleTransaction: (row.settle_transaction as string | null) ?? null,
      paymentRef: (row.payment_ref as string | null) ?? null,
      batchStatus: (row.batch_status as string | null) ?? null,
      batchTxHash: (row.batch_tx_hash as string | null) ?? null,
      receipt: row.receipt_json ? signedGatewayReceiptSchema.parse(JSON.parse(row.receipt_json as string)) : null,
    };
  }
  /** Atomic claim, as in MerchantDeliveryStore: false means another request owns this purchase or nonce. */
  claim(verified: Verified, now: number): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO gateway_deliveries (purchase_id, request_hash, nonce, verified_at, status, updated_at)
         VALUES (?, ?, ?, ?, 'claimed', ?)`,
      )
      .run(verified.request.purchaseId, verified.requestHash, verified.nonce, now, now);
    return Number(result.changes) === 1;
  }
  release(purchaseId: string) {
    this.#db.prepare(`DELETE FROM gateway_deliveries WHERE purchase_id = ? AND status = 'claimed'`).run(purchaseId);
  }
  accept(purchaseId: string, settleTransaction: string, now: number) {
    this.#db
      .prepare(`UPDATE gateway_deliveries SET status = 'accepted', settle_transaction = ?, updated_at = ? WHERE purchase_id = ? AND status = 'claimed'`)
      .run(settleTransaction, now, purchaseId);
  }
  linkPaymentRef(purchaseId: string, paymentRef: string, now: number) {
    this.#db
      .prepare(`UPDATE gateway_deliveries SET payment_ref = ?, updated_at = ? WHERE purchase_id = ? AND payment_ref IS NULL`)
      .run(paymentRef, now, purchaseId);
  }
  deliver(purchaseId: string, receipt: SignedGatewayReceipt, now: number): SignedGatewayReceipt {
    this.#db
      .prepare(`UPDATE gateway_deliveries SET status = 'delivered', receipt_json = ?, updated_at = ? WHERE purchase_id = ? AND status = 'accepted'`)
      .run(JSON.stringify(receipt), now, purchaseId);
    return this.get(purchaseId)!.receipt!;
  }
  recordBatch(purchaseId: string, status: string, txHash: string | null, now: number) {
    this.#db
      .prepare(`UPDATE gateway_deliveries SET batch_status = ?, batch_tx_hash = COALESCE(?, batch_tx_hash), updated_at = ? WHERE purchase_id = ?`)
      .run(status, txHash, now, purchaseId);
  }
}

export type GatewayDeliveryResponse =
  | { status: 200; headers: Record<string, string>; body: Uint8Array; receipt: SignedGatewayReceipt; replayed: boolean }
  | { status: 202; reason: string; paymentRef: string | null }
  | { status: 400 | 402 | 403 | 404 | 409 | 410 | 502 | 503; reason: string };

export interface GatewayDeliveryDeps extends MerchantDeps {
  gateway: GatewayProvider;
  deliveries: GatewayDeliveryStore;
  loadArtifact(contentHash: Hex): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  receiptSigner: GatewayReceiptSigner;
}

/**
 * Merchant path for the Gateway rail. Same guarantees as deliverPaidRequest:
 * binding verified first, one durable claim per purchase and nonce, Gateway
 * settle() called at most once, and a retry replays the stored receipt.
 * A lost or indeterminate settle stays claimed and is reconciled by nonce.
 */
export async function deliverGatewayPaidRequest(input: PaidRequest, deps: GatewayDeliveryDeps): Promise<GatewayDeliveryResponse> {
  const { deliveries } = deps;
  let existing: GatewayDeliveryRecord | undefined;
  try {
    existing = deliveries.get(parseBindingHeader(input.bindingHeader).purchaseId);
  } catch {
    existing = undefined;
  }
  const verifiedAt = existing?.verifiedAt;
  const verified = await verifyPaidRequest(input, verifiedAt === undefined ? deps : { ...deps, now: () => verifiedAt });
  if (!verified.ok) return { status: verified.status, reason: verified.reason };

  if (!existing) {
    if (deliveries.claim(verified, deps.now())) return submitToGateway(verified, input, deps);
    existing = deliveries.get(verified.request.purchaseId);
  }
  if (!existing || existing.nonce !== verified.nonce || existing.requestHash !== verified.requestHash) {
    return { status: 409, reason: "purchase already claimed by a different authorization" };
  }
  switch (existing.status) {
    case "delivered":
      return respond(existing.receipt!, deps, true);
    case "accepted":
      return issueReceipt(verified, deps);
    case "claimed":
      return reconcileInterruptedClaim(verified, deps);
  }
}

async function submitToGateway(verified: Verified, input: PaidRequest, deps: GatewayDeliveryDeps): Promise<GatewayDeliveryResponse> {
  const purchaseId = verified.request.purchaseId;
  const verifyingContract = deps.config.authorizationDomain?.verifyingContract;
  const requirements = gatewayRequirements(verified.request, verifyingContract);
  const payload = gatewayPaymentPayload(verified.request, input.authorization, verifyingContract);
  try {
    const check = await deps.gateway.verify(payload, requirements);
    if (!check.isValid) {
      // Verify does not accept a payment, except a nonce Circle (or the fixture) already recorded.
      if (check.invalidReason === "nonce_already_used") return reconcileInterruptedClaim(verified, deps);
      deps.deliveries.release(purchaseId);
      return { status: 402, reason: `Gateway rejected the authorization: ${check.invalidReason ?? "invalid"}` };
    }
    const settled = await deps.gateway.settle(payload, requirements);
    if (!settled.success) {
      if (isDeterministicGatewayRejection(settled.errorReason)) {
        deps.deliveries.release(purchaseId);
        return { status: 402, reason: `Gateway did not accept the payment: ${settled.errorReason ?? "settle failed"}` };
      }
      // unexpected_error (HTTP 500 body), nonce_already_used, or any other undocumented reason.
      // The payment may already exist. Keep the claim and reconcile; do not settle again.
      return reconcileInterruptedClaim(verified, deps);
    }
    deps.deliveries.accept(purchaseId, settled.transaction || "(empty)", deps.now());
  } catch (error) {
    // Lost response or a thrown client error. Keep the claim. The retry reconciles by nonce
    // and must not call settle() again.
    return { status: 502, reason: `Gateway call failed; outcome unknown, resolve by nonce: ${(error as Error).message}` };
  }
  return issueReceipt(verified, deps);
}

const FULFILLABLE_TRANSFER = new Set<GatewayTransfer["status"]>(["received", "batched", "confirmed", "completed"]);

/** A transfer can resume this purchase only when it is the same authorization and was not failed. */
function transferRejection(transfer: GatewayTransfer, verified: Verified): string | null {
  const { request } = verified;
  if (transfer.nonce?.toLowerCase() !== verified.nonce.toLowerCase()) {
    return "Gateway transfer does not carry this authorization nonce";
  }
  if (transfer.status === "failed") return "Gateway transfer for this nonce failed; the payment was not charged";
  if (!FULFILLABLE_TRANSFER.has(transfer.status)) {
    return `Gateway transfer for this nonce has an unrecognized status (${transfer.status})`;
  }
  if (
    transfer.amount !== request.amount ||
    transfer.toAddress.toLowerCase() !== request.payTo.toLowerCase() ||
    transfer.fromAddress.toLowerCase() !== request.payer.toLowerCase()
  ) {
    return "Gateway transfer for this nonce does not match the request (amount, payer, or recipient)";
  }
  return null;
}

type TransferLookup =
  | { outcome: "transfer"; transfer: GatewayTransfer }
  | { outcome: "missing" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "error"; reason: string };

async function lookupTransfer(verified: Verified, deps: GatewayDeliveryDeps): Promise<TransferLookup> {
  try {
    const transfer = await deps.gateway.transferByNonce({
      nonce: verified.nonce,
      from: verified.request.payer,
      to: verified.request.payTo,
    });
    if (!transfer) return { outcome: "missing" };
    const reason = transferRejection(transfer, verified);
    return reason ? { outcome: "rejected", reason } : { outcome: "transfer", transfer };
  } catch (error) {
    return { outcome: "error", reason: `Gateway nonce lookup failed; outcome unknown: ${(error as Error).message}` };
  }
}

/**
 * An interrupted claim (lost settle response, or an indeterminate settle body) is resolved
 * from Circle's transfer for the original EIP-3009 nonce. Nothing here calls settle().
 */
async function reconcileInterruptedClaim(verified: Verified, deps: GatewayDeliveryDeps): Promise<GatewayDeliveryResponse> {
  const found = await lookupTransfer(verified, deps);
  if (found.outcome === "error" || found.outcome === "rejected") return { status: 502, reason: found.reason };
  if (found.outcome === "missing") {
    return { status: 202, reason: "Gateway submission in progress for this purchase", paymentRef: null };
  }
  const purchaseId = verified.request.purchaseId;
  deps.deliveries.accept(purchaseId, found.transfer.id, deps.now());
  const saved = deps.deliveries.get(purchaseId);
  if (saved?.status === "delivered" && saved.receipt) return respond(saved.receipt, deps, true);
  if (saved?.status !== "accepted") {
    return { status: 202, reason: "Gateway submission in progress for this purchase", paymentRef: saved?.paymentRef ?? null };
  }
  return issueReceipt(verified, deps, found.transfer);
}

async function issueReceipt(verified: Verified, deps: GatewayDeliveryDeps, resolved?: GatewayTransfer): Promise<GatewayDeliveryResponse> {
  const { request } = verified;
  let record = deps.deliveries.get(request.purchaseId)!;
  if (!record.paymentRef) {
    let transfer = resolved;
    if (!transfer) {
      const found = await lookupTransfer(verified, deps);
      if (found.outcome === "error" || found.outcome === "rejected") return { status: 502, reason: found.reason };
      if (found.outcome === "missing") {
        return { status: 202, reason: "accepted by Gateway; per-payment transfer not visible yet, retry", paymentRef: null };
      }
      transfer = found.transfer;
    } else {
      const reason = transferRejection(transfer, verified);
      if (reason) return { status: 502, reason };
    }
    deps.deliveries.linkPaymentRef(request.purchaseId, transfer.id, deps.now());
    deps.deliveries.recordBatch(request.purchaseId, transfer.status, transfer.txHash, deps.now());
    record = deps.deliveries.get(request.purchaseId)!;
  }
  const body = await deps.loadArtifact(request.expectedContentHash);
  if (!body || hashContent(body) !== request.expectedContentHash) {
    return { status: 503, reason: "paid artifact unavailable; retry to receive the receipt" };
  }
  const receipt = await signGatewayReceipt({
    signer: deps.receiptSigner,
    merchantId: deps.config.merchantId,
    request,
    paymentRef: record.paymentRef!,
    authorizationNonce: verified.nonce,
    issuedAt: deps.now(),
  });
  return respond(deps.deliveries.deliver(request.purchaseId, receipt, deps.now()), deps, false, body);
}

async function respond(receipt: SignedGatewayReceipt, deps: GatewayDeliveryDeps, replayed: boolean, loaded?: Uint8Array): Promise<GatewayDeliveryResponse> {
  const body = loaded ?? (await deps.loadArtifact(receipt.contentHash));
  if (!body || hashContent(body) !== receipt.contentHash) return { status: 503, reason: "paid artifact unavailable; retry to receive it" };
  return { status: 200, headers: { [RECEIPT_HEADER]: encodeGatewayReceiptHeader(receipt) }, body, receipt, replayed };
}

/** Polls Circle's per-payment record and stores batch status and batch tx hash; acceptance is never rewritten. */
export async function refreshGatewayBatch(purchaseId: string, deps: { gateway: GatewayProvider; deliveries: GatewayDeliveryStore; now(): number }) {
  const record = deps.deliveries.get(purchaseId);
  if (!record?.paymentRef) return undefined;
  const transfer = await deps.gateway.transferById(record.paymentRef);
  deps.deliveries.recordBatch(purchaseId, transfer.status, transfer.txHash, deps.now());
  return transfer;
}
