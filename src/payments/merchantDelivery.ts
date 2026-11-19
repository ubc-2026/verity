import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { parseBindingHeader } from "./binding.ts";
import {
  encodeReceiptHeader,
  RECEIPT_HEADER,
  signDeliveryReceipt,
  signedDeliveryReceiptSchema,
  type ReceiptSigner,
  type SignedDeliveryReceiptV1,
} from "./deliveryReceipt.ts";
import { verifyPaidRequest, type Eip3009Authorization, type MerchantDeps, type PaidRequest, type VerifyResult } from "./merchant.ts";
import { hashContent } from "./researchRequest.ts";

type Verified = Extract<VerifyResult, { ok: true }>;

/**
 * Settlement as the delivery path needs it. A thrown error that carries
 * `txHash` means a transfer was submitted; `pending: true` means its outcome
 * is still unknown (SettlementError has this shape).
 */
export interface DeliverySettlementAdapter {
  settle(verified: Verified, authorization: Eip3009Authorization): Promise<{ txHash: Hex }>;
  /** Waits on an already-submitted transfer instead of submitting again. */
  resume?(verified: Verified, authorization: Eip3009Authorization, txHash: Hex): Promise<{ txHash: Hex }>;
}

/**
 * claimed   verified and claimed; settlement not yet known to be submitted
 * submitted transfer submitted (txHash known), outcome not yet confirmed
 * settled   transfer confirmed; receipt not yet issued
 * delivered receipt signed and stored; retries replay it
 */
export type MerchantDeliveryStatus = "claimed" | "submitted" | "settled" | "delivered";

export interface MerchantDeliveryRecord {
  purchaseId: string;
  requestHash: Hex;
  nonce: Hex;
  contentHash: Hex;
  verifiedAt: number;
  status: MerchantDeliveryStatus;
  txHash: Hex | null;
  receipt: SignedDeliveryReceiptV1 | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_deliveries (
  purchase_id  TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  nonce        TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  verified_at  INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('claimed', 'submitted', 'settled', 'delivered')),
  tx_hash      TEXT,
  receipt_json TEXT,
  updated_at   INTEGER NOT NULL,
  CHECK ((status = 'delivered') = (receipt_json IS NOT NULL)),
  CHECK (status = 'claimed' OR tx_hash IS NOT NULL)
) STRICT;
`;

/** Merchant-side durable record of each paid purchase and its receipt. */
export class MerchantDeliveryStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
  }

  close() {
    this.#db.close();
  }

  get(purchaseId: string): MerchantDeliveryRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM merchant_deliveries WHERE purchase_id = ?`).get(purchaseId) as
      | Record<string, string | number | null>
      | undefined;
    if (!row) return undefined;
    return {
      purchaseId: row.purchase_id as string,
      requestHash: row.request_hash as Hex,
      nonce: row.nonce as Hex,
      contentHash: row.content_hash as Hex,
      verifiedAt: row.verified_at as number,
      status: row.status as MerchantDeliveryStatus,
      txHash: (row.tx_hash as Hex | null) ?? null,
      receipt: row.receipt_json ? signedDeliveryReceiptSchema.parse(JSON.parse(row.receipt_json as string)) : null,
    };
  }

  /** Atomic claim. False means another request already owns this purchase or nonce. */
  claim(verified: Verified, now: number): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO merchant_deliveries (purchase_id, request_hash, nonce, content_hash, verified_at, status, updated_at)
         VALUES (?, ?, ?, ?, ?, 'claimed', ?)`,
      )
      .run(verified.request.purchaseId, verified.requestHash, verified.nonce, verified.request.expectedContentHash, now, now);
    return Number(result.changes) === 1;
  }

  /** Drops a claim whose settlement failed before anything was submitted. */
  release(purchaseId: string) {
    this.#db.prepare(`DELETE FROM merchant_deliveries WHERE purchase_id = ? AND status = 'claimed'`).run(purchaseId);
  }

  mark(purchaseId: string, status: "submitted" | "settled", txHash: Hex, now: number) {
    this.#db
      .prepare(`UPDATE merchant_deliveries SET status = ?, tx_hash = ?, updated_at = ? WHERE purchase_id = ? AND status <> 'delivered'`)
      .run(status, txHash.toLowerCase(), now, purchaseId);
  }

  /** Stores the first receipt only; a concurrent second signer loses and the stored one wins. */
  deliver(purchaseId: string, receipt: SignedDeliveryReceiptV1, now: number): SignedDeliveryReceiptV1 {
    this.#db
      .prepare(`UPDATE merchant_deliveries SET status = 'delivered', receipt_json = ?, updated_at = ? WHERE purchase_id = ? AND status = 'settled'`)
      .run(JSON.stringify(receipt), now, purchaseId);
    return this.get(purchaseId)!.receipt!;
  }
}

export type DeliveryResponse =
  | {
      status: 200;
      headers: Record<string, string>;
      body: Uint8Array;
      receipt: SignedDeliveryReceiptV1;
      /** True when a stored receipt was replayed and nothing was settled. */
      replayed: boolean;
    }
  | { status: 202; reason: string; txHash: Hex | null }
  | { status: 400 | 402 | 403 | 404 | 409 | 410 | 502 | 503; reason: string; txHash?: Hex | null };

export interface MerchantDeliveryDeps extends MerchantDeps {
  settlement: DeliverySettlementAdapter;
  deliveries: MerchantDeliveryStore;
  loadArtifact(contentHash: Hex): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  receiptSigner: ReceiptSigner;
}

const submittedTx = (error: unknown) => error as { txHash?: Hex; pending?: boolean } | null;

/**
 * Merchant path with delivery: verify the binding, settle once, sign a
 * DeliveryReceiptV1 over the exact bytes served, and persist it. A retry of the
 * same paid request is re-verified (at the original verification time, so an
 * expired window does not strand a paid buyer) and then replays the stored
 * receipt, resumes a submitted transfer, or finishes a settled one. It never
 * submits a second transfer.
 */
export async function deliverPaidRequest(input: PaidRequest, deps: MerchantDeliveryDeps): Promise<DeliveryResponse> {
  const { deliveries } = deps;
  let existing: MerchantDeliveryRecord | undefined;
  try {
    existing = deliveries.get(parseBindingHeader(input.bindingHeader).purchaseId);
  } catch {
    existing = undefined; // verifyPaidRequest reports the binding error.
  }

  const verifiedAt = existing?.verifiedAt;
  const verified = await verifyPaidRequest(input, verifiedAt === undefined ? deps : { ...deps, now: () => verifiedAt });
  if (!verified.ok) return { status: verified.status, reason: verified.reason };

  if (!existing) {
    if (!deliveries.claim(verified, deps.now())) existing = deliveries.get(verified.request.purchaseId);
    else return finishSettlement(verified, () => deps.settlement.settle(verified, input.authorization), deps);
  }
  if (!existing || existing.nonce !== verified.nonce || existing.requestHash !== verified.requestHash) {
    return { status: 409, reason: "purchase already claimed by a different authorization" };
  }

  switch (existing.status) {
    case "delivered":
      return respond(existing.receipt!, deps, true);
    case "settled":
      return issueReceipt(verified, existing.txHash!, deps);
    case "submitted":
      if (!deps.settlement.resume) return { status: 202, reason: "settlement submitted; outcome pending", txHash: existing.txHash };
      return finishSettlement(verified, () => deps.settlement.resume!(verified, input.authorization, existing.txHash!), deps);
    case "claimed":
      return { status: 202, reason: "settlement in progress for this purchase", txHash: null };
  }
}

async function finishSettlement(verified: Verified, run: () => Promise<{ txHash: Hex }>, deps: MerchantDeliveryDeps): Promise<DeliveryResponse> {
  const purchaseId = verified.request.purchaseId;
  let txHash: Hex;
  try {
    ({ txHash } = await run());
  } catch (error) {
    const submitted = submittedTx(error);
    if (submitted?.txHash) {
      // Keep the tx hash: a retry waits on it and never submits again.
      deps.deliveries.mark(purchaseId, "submitted", submitted.txHash, deps.now());
      if (submitted.pending) return { status: 202, reason: `settlement outcome pending: ${(error as Error).message}`, txHash: submitted.txHash };
      return { status: 502, reason: `settlement failed after submission: ${(error as Error).message}`, txHash: submitted.txHash };
    }
    if (deps.deliveries.get(purchaseId)?.status === "claimed") deps.deliveries.release(purchaseId);
    return { status: 502, reason: `settlement failed before submission: ${(error as Error).message}`, txHash: null };
  }
  deps.deliveries.mark(purchaseId, "settled", txHash, deps.now());
  return issueReceipt(verified, txHash.toLowerCase() as Hex, deps);
}

async function issueReceipt(verified: Verified, txHash: Hex, deps: MerchantDeliveryDeps): Promise<DeliveryResponse> {
  const { request } = verified;
  const body = await deps.loadArtifact(request.expectedContentHash);
  // Never sign for bytes that are not the quoted artifact. The record stays
  // `settled`, so a retry issues the receipt once the artifact is back.
  if (!body || hashContent(body) !== request.expectedContentHash) {
    return { status: 503, reason: "paid artifact unavailable; retry to receive the receipt", txHash };
  }
  const receipt = await signDeliveryReceipt({
    signer: deps.receiptSigner,
    merchantId: deps.config.merchantId,
    request,
    contentHash: request.expectedContentHash,
    txHash,
    issuedAt: deps.now(),
  });
  const stored = deps.deliveries.deliver(request.purchaseId, receipt, deps.now());
  return respond(stored, deps, false, body);
}

async function respond(receipt: SignedDeliveryReceiptV1, deps: MerchantDeliveryDeps, replayed: boolean, loaded?: Uint8Array): Promise<DeliveryResponse> {
  const body = loaded ?? (await deps.loadArtifact(receipt.contentHash));
  if (!body || hashContent(body) !== receipt.contentHash) {
    return { status: 503, reason: "paid artifact unavailable; retry to receive it", txHash: receipt.txHash };
  }
  return {
    status: 200,
    headers: { [RECEIPT_HEADER]: encodeReceiptHeader(receipt) },
    body,
    receipt,
    replayed,
  };
}
