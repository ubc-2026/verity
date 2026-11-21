import { isAddress, type Hex } from "viem";
import { ARC_TESTNET_CHAIN_ID, ARC_USDC, type LedgerStatus } from "./chain.ts";
import { overdueEvent, type OverdueEvent } from "./overdue.ts";
import { parseStreamPayload, type ParsedBatch, type TxEvidence } from "./parse.ts";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface Purchase {
  purchaseId: string;
  requestHash: Hex;
  nonce: Hex;
  payer: Hex;
  payTo: Hex;
  amountBaseUnits: string;
  token: Hex;
  chainId: number;
  merchantLabel: string;
  deliveryDeadlineUtc: string;
  environment: "fixture" | "arc-testnet";
}

export interface Delivery {
  purchaseId: string;
  ok: boolean;
  detail: string;
  contentHash: Hex | null;
  recordedAtUtc: string;
}

interface CanonicalBlock {
  number: number;
  hash: Hex;
  parentHash: Hex | null;
}

/** A signed webhook delivery that was ingested, kept until its signature can no longer be replayed. */
export interface WebhookReceipt {
  nonce: string;
  expiresAtMs: number;
}

export interface LedgerState {
  purchases: Purchase[];
  deliveries: Delivery[];
  blocks: CanonicalBlock[];
  evidence: TxEvidence[];
  emittedPurchaseIds: string[];
  pendingEvents: OverdueEvent[];
  /** Optional so ledgers saved before replay protection still load. */
  webhookNonces?: WebhookReceipt[];
}

export interface PurchaseView {
  purchaseId: string;
  environment: "fixture" | "arc-testnet";
  txHash: Hex | null;
  duplicateTxHash: Hex | null;
  amountBaseUnits: string;
  ledgerStatus: LedgerStatus;
  settlementConfirmed: boolean;
  deliveryDeadlineUtc: string;
  merchantLabel: string;
  detail: string;
  dataLabel?: "FIXTURE";
}

export interface UnmatchedPayment {
  ledgerStatus: "Unmatched payment";
  txHash: Hex;
  from: Hex;
  to: Hex;
  amountBaseUnits: string;
  blockNumber: number;
  detail: string;
}

export interface LedgerOptions {
  token?: Hex;
  chainId?: number;
  finalityDepth?: number;
  expectedNetwork?: string | null;
}

const EMPTY: LedgerState = {
  purchases: [],
  deliveries: [],
  blocks: [],
  evidence: [],
  emittedPurchaseIds: [],
  pendingEvents: [],
};

function bytes32(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new LedgerError("expected 32-byte hex");
  return value.toLowerCase() as Hex;
}

function address(value: string): Hex {
  if (!isAddress(value)) throw new LedgerError("invalid address");
  return value.toLowerCase() as Hex;
}

function samePurchase(left: Purchase, right: Purchase): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fieldMatch(purchase: Purchase, tx: TxEvidence): boolean {
  const auth = tx.auths.find((entry) => entry.nonce === purchase.nonce);
  if (!auth || auth.authorizer !== purchase.payer) return false;
  return tx.transfers.some(
    (transfer) => transfer.from === purchase.payer && transfer.to === purchase.payTo && transfer.value === purchase.amountBaseUnits,
  );
}

export class Ledger {
  readonly token: Hex;
  readonly chainId: number;
  readonly finalityDepth: number;
  readonly expectedNetwork: string | null;
  #state: LedgerState;
  #onChange?: () => void;

  constructor(state: LedgerState = structuredClone(EMPTY), options: LedgerOptions = {}, onChange?: () => void) {
    this.#state = state;
    this.token = options.token ?? ARC_USDC;
    this.chainId = options.chainId ?? ARC_TESTNET_CHAIN_ID;
    this.finalityDepth = options.finalityDepth ?? 1;
    this.expectedNetwork = options.expectedNetwork ?? null;
    this.#onChange = onChange;
  }

  snapshot(): LedgerState {
    return structuredClone(this.#state);
  }

  registerPurchase(input: Purchase): void {
    const purchase: Purchase = {
      purchaseId: input.purchaseId,
      requestHash: bytes32(input.requestHash),
      nonce: bytes32(input.nonce),
      payer: address(input.payer),
      payTo: address(input.payTo),
      amountBaseUnits: input.amountBaseUnits,
      token: address(input.token),
      chainId: input.chainId,
      merchantLabel: input.merchantLabel,
      deliveryDeadlineUtc: input.deliveryDeadlineUtc,
      environment: input.environment,
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(purchase.purchaseId)) {
      throw new LedgerError("invalid purchase id");
    }
    if (!/^[1-9][0-9]*$/.test(purchase.amountBaseUnits)) throw new LedgerError("invalid amount");
    if (purchase.chainId !== this.chainId) throw new LedgerError("unexpected chain");
    if (purchase.token !== this.token) throw new LedgerError("unexpected token");
    if (Number.isNaN(Date.parse(purchase.deliveryDeadlineUtc))) throw new LedgerError("invalid deadline");
    purchase.merchantLabel = purchase.merchantLabel.trim();
    if (!purchase.merchantLabel) throw new LedgerError("merchant label is required");
    const existing = this.#state.purchases.find((item) => item.purchaseId === purchase.purchaseId);
    if (existing) {
      if (!samePurchase(existing, purchase)) throw new LedgerError("purchase already registered with different terms");
      return;
    }
    if (this.#state.purchases.some((item) => item.nonce === purchase.nonce)) {
      throw new LedgerError("nonce already belongs to another purchase");
    }
    this.#state.purchases.push(purchase);
    this.#touch();
  }

  noteDelivery(input: { purchaseId: string; ok: boolean; detail: string; contentHash: string | null; recordedAtUtc: string }): void {
    const purchase = this.#purchase(input.purchaseId);
    if (!purchase) throw new LedgerError("unknown purchase");
    const contentHash = input.contentHash ? bytes32(input.contentHash) : null;
    if (input.ok && !contentHash) throw new LedgerError("verified delivery requires a content hash");
    const delivery: Delivery = {
      purchaseId: purchase.purchaseId,
      ok: input.ok,
      detail: input.detail.slice(0, 240),
      contentHash,
      recordedAtUtc: input.recordedAtUtc,
    };
    const index = this.#state.deliveries.findIndex((item) => item.purchaseId === purchase.purchaseId);
    if (index >= 0) this.#state.deliveries[index] = delivery;
    else this.#state.deliveries.push(delivery);
    this.#touch();
  }

  /** True when a signed delivery with this nonce was ingested and its record has not expired. */
  seenWebhook(nonce: string, nowMs: number): boolean {
    return (this.#state.webhookNonces ?? []).some((entry) => entry.nonce === nonce && entry.expiresAtMs > nowMs);
  }

  /**
   * Applies a stream batch. With a receipt, the delivery's nonce is recorded in the same state change,
   * so the batch and its replay record are saved together or not at all.
   */
  ingest(
    body: unknown,
    receipt?: { nonce: string; expiresAtMs: number; nowMs: number },
  ): { blocks: number; transactions: number; reorgs: number } {
    const batch = parseStreamPayload(body, this.token);
    if (this.expectedNetwork && batch.network && batch.network !== this.expectedNetwork) {
      throw new LedgerError(`unexpected network ${batch.network}`);
    }
    this.#apply(batch);
    if (receipt) {
      const kept = (this.#state.webhookNonces ?? []).filter(
        (entry) => entry.expiresAtMs > receipt.nowMs && entry.nonce !== receipt.nonce,
      );
      kept.push({ nonce: receipt.nonce, expiresAtMs: receipt.expiresAtMs });
      this.#state.webhookNonces = kept;
    }
    this.#touch();
    return {
      blocks: batch.blocks.length,
      transactions: batch.blocks.reduce((sum, block) => sum + block.txs.length, 0),
      reorgs: batch.reorgs.length,
    };
  }

  view(purchaseId: string): PurchaseView | undefined {
    const purchase = this.#purchase(purchaseId);
    return purchase ? this.#view(purchase) : undefined;
  }

  list(): PurchaseView[] {
    return this.#state.purchases.map((purchase) => this.#view(purchase));
  }

  unmatched(): UnmatchedPayment[] {
    const known = new Set(this.#state.purchases.map((purchase) => purchase.nonce));
    const rows: UnmatchedPayment[] = [];
    for (const tx of this.#canonicalEvidence()) {
      if (tx.auths.length === 0) {
        for (const transfer of tx.transfers) {
          rows.push({
            ledgerStatus: "Unmatched payment",
            txHash: tx.txHash,
            from: transfer.from,
            to: transfer.to,
            amountBaseUnits: transfer.value,
            blockNumber: tx.blockNumber,
            detail: "USDC transfer has no AuthorizationUsed nonce",
          });
        }
        continue;
      }
      for (const auth of tx.auths) {
        if (known.has(auth.nonce)) continue;
        const transfer = tx.transfers.find((item) => item.from === auth.authorizer);
        rows.push({
          ledgerStatus: "Unmatched payment",
          txHash: tx.txHash,
          from: auth.authorizer,
          to: transfer?.to ?? auth.authorizer,
          amountBaseUnits: transfer?.value ?? "0",
          blockNumber: tx.blockNumber,
          detail: "authorization nonce does not match a registered purchase",
        });
      }
    }
    return rows;
  }

  /** Queue a `verity.overdue_delivery.v1` event once a confirmed payment is past its deadline. */
  collectOverdue(now: Date): OverdueEvent[] {
    let queued = false;
    for (const purchase of this.#state.purchases) {
      if (this.#state.emittedPurchaseIds.includes(purchase.purchaseId)) continue;
      if (this.#state.pendingEvents.some((event) => event.purchaseId === purchase.purchaseId)) continue;
      const view = this.#view(purchase);
      if (view.ledgerStatus !== "Paid, delivery missing" || !view.settlementConfirmed || !view.txHash) continue;
      if (Date.parse(purchase.deliveryDeadlineUtc) >= now.getTime()) continue;
      this.#state.pendingEvents.push(
        overdueEvent({
          environment: purchase.environment,
          purchaseId: purchase.purchaseId,
          txHash: view.txHash,
          amountBaseUnits: purchase.amountBaseUnits,
          merchantLabel: purchase.merchantLabel,
          deliveryDeadlineUtc: purchase.deliveryDeadlineUtc,
          emittedAt: now,
        }),
      );
      queued = true;
    }
    if (queued) this.#touch();
    return structuredClone(this.#state.pendingEvents);
  }

  acknowledge(purchaseId: string, eventId: string): void {
    const pending = this.#state.pendingEvents.find((event) => event.purchaseId === purchaseId && event.eventId === eventId);
    if (!pending) return;
    this.#state.pendingEvents = this.#state.pendingEvents.filter((event) => event.eventId !== eventId);
    if (!this.#state.emittedPurchaseIds.includes(purchaseId)) this.#state.emittedPurchaseIds.push(purchaseId);
    this.#touch();
  }

  #apply(batch: ParsedBatch): void {
    for (const reorg of batch.reorgs) {
      this.#state.blocks = this.#state.blocks.filter((block) => block.number !== reorg.number && block.hash !== reorg.hash);
    }
    const ordered = [...batch.blocks].sort((left, right) => left.number - right.number);
    for (const block of ordered) {
      const parent = this.#state.blocks.find((item) => item.number === block.number - 1);
      if (parent && block.parentHash && parent.hash !== block.parentHash) {
        this.#state.blocks = this.#state.blocks.filter((item) => item.number < parent.number);
      }
      this.#state.blocks = this.#state.blocks.filter((item) => item.number !== block.number);
      this.#state.blocks.push({ number: block.number, hash: block.hash, parentHash: block.parentHash });
      this.#state.evidence = this.#state.evidence.filter((tx) => tx.blockNumber !== block.number && tx.blockHash !== block.hash);
      this.#state.evidence.push(...block.txs);
    }
    const canonical = new Map(this.#state.blocks.map((block) => [block.number, block.hash]));
    this.#state.evidence = this.#state.evidence.filter((tx) => canonical.get(tx.blockNumber) === tx.blockHash);
  }

  #canonicalEvidence(): TxEvidence[] {
    const canonical = new Map(this.#state.blocks.map((block) => [block.number, block.hash]));
    return this.#state.evidence.filter((tx) => canonical.get(tx.blockNumber) === tx.blockHash);
  }

  #head(): number {
    return this.#state.blocks.reduce((max, block) => Math.max(max, block.number), 0);
  }

  #final(blockNumber: number): boolean {
    return this.#head() - blockNumber >= this.finalityDepth;
  }

  #purchase(purchaseId: string): Purchase | undefined {
    return this.#state.purchases.find((purchase) => purchase.purchaseId === purchaseId);
  }

  #view(purchase: Purchase): PurchaseView {
    const delivery = this.#state.deliveries.find((item) => item.purchaseId === purchase.purchaseId);
    const nonceTxs = this.#canonicalEvidence().filter((tx) => tx.auths.some((auth) => auth.nonce === purchase.nonce));
    const good = nonceTxs.filter((tx) => fieldMatch(purchase, tx));
    const bad = nonceTxs.filter((tx) => !fieldMatch(purchase, tx));
    const confirmed = good.filter((tx) => this.#final(tx.blockNumber));
    const primary = confirmed[0] ?? good[0] ?? nonceTxs[0] ?? null;
    const secondary = nonceTxs.find((tx) => tx.txHash !== primary?.txHash) ?? null;

    let ledgerStatus: LedgerStatus = "Payment pending";
    let detail = "waiting for a matching Arc Testnet settlement";
    if (delivery && !delivery.ok) {
      ledgerStatus = "Mismatch";
      detail = delivery.detail || "delivery does not match the quoted bytes";
    } else if (bad.length > 0 && good.length === 0) {
      ledgerStatus = "Mismatch";
      detail = "authorization nonce was seen, but the payer, recipient, or amount differs";
    } else if (nonceTxs.length > 1) {
      ledgerStatus = "Duplicate payment";
      detail = "more than one settlement used this purchase nonce";
    } else if (good.length === 1 && this.#final(good[0]!.blockNumber) && delivery?.ok) {
      ledgerStatus = "Reconciled";
      detail = "confirmed transfer matches the purchase and the delivery receipt";
    } else if (good.length === 1 && this.#final(good[0]!.blockNumber)) {
      ledgerStatus = "Paid, delivery missing";
      detail = "confirmed transfer, no verified delivery";
    } else if (good.length === 1) {
      ledgerStatus = "Payment pending";
      detail = "matching transfer seen, waiting for finality";
    } else if (delivery?.ok) {
      ledgerStatus = "Delivered, payment unconfirmed";
      detail = delivery.detail || "delivery verified, matching transfer not confirmed";
    }

    const settlementConfirmed = confirmed.length > 0 && (ledgerStatus === "Reconciled" || ledgerStatus === "Paid, delivery missing" || ledgerStatus === "Duplicate payment" || ledgerStatus === "Mismatch");

    return {
      purchaseId: purchase.purchaseId,
      environment: purchase.environment,
      txHash: primary?.txHash ?? null,
      duplicateTxHash: secondary?.txHash ?? null,
      amountBaseUnits: purchase.amountBaseUnits,
      ledgerStatus,
      settlementConfirmed,
      deliveryDeadlineUtc: purchase.deliveryDeadlineUtc,
      merchantLabel: purchase.merchantLabel,
      detail,
      ...(purchase.environment === "fixture" ? { dataLabel: "FIXTURE" as const } : {}),
    };
  }

  #touch(): void {
    this.#onChange?.();
  }
}

export function emptyState(): LedgerState {
  return structuredClone(EMPTY);
}
