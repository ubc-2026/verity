import canonicalize from "canonicalize";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import { computeRequestHash, hashContent, type ResearchRequestV1 } from "./researchRequest.ts";
import { parseStrictJson } from "./strictJson.ts";

/**
 * DeliveryReceiptV1: the merchant's signed statement that, for one settled
 * purchase, it delivered bytes whose keccak256 is `contentHash`.
 *
 * Signed as EIP-712 typed data so any EVM key (and later a contract) can check
 * it. The buyer verifies the signer against a pinned merchant address, then
 * hashes the raw response bytes before parsing them.
 */
export const DELIVERY_RECEIPT_VERSION = "verity-delivery-receipt-v1";

/** PROVISIONAL wire format; coordinate with the merchant workstream. */
export const RECEIPT_HEADER = "X-Verity-Receipt";

export const DELIVERY_RECEIPT_DOMAIN = { name: "VerityDeliveryReceipt", version: "1" } as const;

export const DELIVERY_RECEIPT_TYPES = {
  DeliveryReceipt: [
    { name: "version", type: "string" },
    { name: "merchantId", type: "string" },
    { name: "merchant", type: "address" },
    { name: "purchaseId", type: "string" },
    { name: "quoteId", type: "string" },
    { name: "requestHash", type: "bytes32" },
    { name: "contentHash", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "txHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address")
  .transform((value) => value.toLowerCase() as Hex);
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 32-byte hex")
  .transform((value) => value.toLowerCase() as Hex);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const deliveryReceiptSchema = z.strictObject({
  version: z.literal(DELIVERY_RECEIPT_VERSION),
  merchantId: identifier,
  merchant: address,
  purchaseId: identifier,
  quoteId: identifier,
  requestHash: bytes32,
  contentHash: bytes32,
  chainId: positiveInt,
  txHash: bytes32,
  issuedAt: positiveInt,
});

export const signedDeliveryReceiptSchema = deliveryReceiptSchema.extend({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte signature").transform((v) => v.toLowerCase() as Hex),
});

export type DeliveryReceiptV1 = z.output<typeof deliveryReceiptSchema>;
export type SignedDeliveryReceiptV1 = z.output<typeof signedDeliveryReceiptSchema>;

/** What the merchant's receipt key must provide; a viem LocalAccount fits. */
export interface ReceiptSigner {
  address: Hex;
  signTypedData(args: {
    domain: typeof DELIVERY_RECEIPT_DOMAIN;
    types: typeof DELIVERY_RECEIPT_TYPES;
    primaryType: "DeliveryReceipt";
    message: ReturnType<typeof typedMessage>;
  }): Promise<Hex>;
}

function typedMessage(receipt: DeliveryReceiptV1) {
  return { ...receipt, chainId: BigInt(receipt.chainId), issuedAt: BigInt(receipt.issuedAt) };
}

/** EIP-712 digest of the unsigned receipt. Stable identity for idempotent acceptance. */
export function receiptDigest(receipt: DeliveryReceiptV1): Hex {
  return hashTypedData({
    domain: DELIVERY_RECEIPT_DOMAIN,
    types: DELIVERY_RECEIPT_TYPES,
    primaryType: "DeliveryReceipt",
    message: typedMessage(receipt),
  });
}

/** Merchant side: builds and signs the receipt for one settled purchase. */
export async function signDeliveryReceipt(args: {
  signer: ReceiptSigner;
  merchantId: string;
  request: ResearchRequestV1;
  contentHash: Hex;
  txHash: Hex;
  issuedAt: number;
}): Promise<SignedDeliveryReceiptV1> {
  const receipt = deliveryReceiptSchema.parse({
    version: DELIVERY_RECEIPT_VERSION,
    merchantId: args.merchantId,
    merchant: args.signer.address,
    purchaseId: args.request.purchaseId,
    quoteId: args.request.quoteId,
    requestHash: computeRequestHash(args.request),
    contentHash: args.contentHash,
    chainId: args.request.chainId,
    txHash: args.txHash,
    issuedAt: args.issuedAt,
  });
  const signature = await args.signer.signTypedData({
    domain: DELIVERY_RECEIPT_DOMAIN,
    types: DELIVERY_RECEIPT_TYPES,
    primaryType: "DeliveryReceipt",
    message: typedMessage(receipt),
  });
  return signedDeliveryReceiptSchema.parse({ ...receipt, signature });
}

/** Header value: base64url of the RFC 8785 canonical JSON of the signed receipt. */
export function encodeReceiptHeader(receipt: SignedDeliveryReceiptV1): string {
  return Buffer.from(canonicalize(receipt)!, "utf8").toString("base64url");
}

export class DeliveryReceiptError extends Error {
  override name = "DeliveryReceiptError";
}

export function parseReceiptHeader(value: string | undefined): SignedDeliveryReceiptV1 {
  if (!value) throw new DeliveryReceiptError(`missing ${RECEIPT_HEADER} header`);
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new DeliveryReceiptError("receipt header is not base64url");
  let decoded: unknown;
  try {
    decoded = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url")));
  } catch (error) {
    throw new DeliveryReceiptError(`receipt is not strict JSON: ${(error as Error).message}`);
  }
  const parsed = signedDeliveryReceiptSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new DeliveryReceiptError(`invalid receipt: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** The merchant key the buyer pins out of band (config), never taken from the response. */
export interface TrustedMerchant {
  merchantId: string;
  receiptSigner: Hex;
}

export type DeliveryRejection = "malformed_receipt" | "wrong_signer" | "binding_mismatch" | "content_mismatch" | "tx_mismatch";

export type DeliveryVerification =
  | { ok: true; receipt: SignedDeliveryReceiptV1; digest: Hex; contentHash: Hex }
  | { ok: false; code: DeliveryRejection; reason: string };

/**
 * Buyer-side verifier. Accepts only if:
 *  1. the receipt parses strictly,
 *  2. its EIP-712 signature recovers to the pinned merchant key,
 *  3. it binds the buyer's own stored request (merchant, purchase, quote,
 *     request hash, chain, expected content hash),
 *  4. keccak256 of the raw response bytes equals the receipt's content hash,
 *  5. its tx hash equals the known settlement tx, when one is known.
 * Nothing in the response is trusted to select the key or the expected values.
 */
export async function verifyDelivery(args: {
  receiptHeader: string | undefined;
  body: Uint8Array;
  trusted: TrustedMerchant;
  request: ResearchRequestV1;
  expectedTxHash?: Hex | null;
}): Promise<DeliveryVerification> {
  const { trusted, request } = args;
  const reject = (code: DeliveryRejection, reason: string): DeliveryVerification => ({ ok: false, code, reason });

  let receipt: SignedDeliveryReceiptV1;
  try {
    receipt = parseReceiptHeader(args.receiptHeader);
  } catch (error) {
    return reject("malformed_receipt", (error as Error).message);
  }

  const { signature, ...unsigned } = receipt;
  let signer: Hex;
  try {
    signer = await recoverTypedDataAddress({
      domain: DELIVERY_RECEIPT_DOMAIN,
      types: DELIVERY_RECEIPT_TYPES,
      primaryType: "DeliveryReceipt",
      message: typedMessage(unsigned),
      signature,
    });
  } catch {
    return reject("malformed_receipt", "signature does not recover");
  }
  const pinned = trusted.receiptSigner.toLowerCase();
  if (signer.toLowerCase() !== pinned) return reject("wrong_signer", `receipt signed by ${signer}, pinned merchant key is ${trusted.receiptSigner}`);
  if (receipt.merchant !== pinned) return reject("wrong_signer", "receipt names a different merchant key");

  const bindings: Array<[string, unknown, unknown]> = [
    ["merchantId", receipt.merchantId, trusted.merchantId],
    ["request merchantId", request.merchantId, trusted.merchantId],
    ["purchaseId", receipt.purchaseId, request.purchaseId],
    ["quoteId", receipt.quoteId, request.quoteId],
    ["requestHash", receipt.requestHash, computeRequestHash(request)],
    ["chainId", receipt.chainId, request.chainId],
    ["contentHash", receipt.contentHash, request.expectedContentHash],
  ];
  const differing = bindings.filter(([, got, want]) => got !== want).map(([name]) => name);
  if (differing.length > 0) return reject("binding_mismatch", `receipt does not bind this request: ${differing.join(", ")}`);

  // Hash the bytes exactly as received, before anything parses them.
  const contentHash = hashContent(args.body);
  if (contentHash !== receipt.contentHash) {
    return reject("content_mismatch", `response bytes hash to ${contentHash}, receipt says ${receipt.contentHash}`);
  }

  if (args.expectedTxHash && args.expectedTxHash.toLowerCase() !== receipt.txHash) {
    return reject("tx_mismatch", `receipt tx ${receipt.txHash} differs from settlement tx ${args.expectedTxHash}`);
  }

  return { ok: true, receipt, digest: receiptDigest(unsigned), contentHash };
}

/** Where the buyer records accepted deliveries; ReconciliationLedger implements it. */
export interface DeliveryAcceptanceStore {
  recordVerifiedDelivery(args: { receipt: SignedDeliveryReceiptV1; digest: Hex; now: number }): DeliveryRecordOutcome;
}

export type DeliveryRecordOutcome =
  | { kind: "reconciled"; purchaseId: string }
  | { kind: "delivered_payment_unconfirmed"; purchaseId: string }
  | { kind: "delivery_already_recorded"; purchaseId: string; ledgerOutcome: string }
  | { kind: "mismatch"; purchaseId: string; detail: string };

export type AcceptResult =
  | { accepted: true; body: Uint8Array; receipt: SignedDeliveryReceiptV1; outcome: DeliveryRecordOutcome }
  | { accepted: false; code: DeliveryRejection | "ledger_mismatch"; reason: string };

/**
 * Buyer acceptance: verify, then record. The body is returned to the caller
 * only after both pass. Re-accepting the same receipt is a no-op.
 */
export async function acceptDelivery(args: {
  response: { body: Uint8Array; receiptHeader: string | undefined };
  trusted: TrustedMerchant;
  request: ResearchRequestV1;
  expectedTxHash?: Hex | null;
  store: DeliveryAcceptanceStore;
  now: number;
}): Promise<AcceptResult> {
  const verification = await verifyDelivery({
    receiptHeader: args.response.receiptHeader,
    body: args.response.body,
    trusted: args.trusted,
    request: args.request,
    expectedTxHash: args.expectedTxHash,
  });
  if (!verification.ok) return { accepted: false, code: verification.code, reason: verification.reason };
  const outcome = args.store.recordVerifiedDelivery({ receipt: verification.receipt, digest: verification.digest, now: args.now });
  if (outcome.kind === "mismatch") return { accepted: false, code: "ledger_mismatch", reason: outcome.detail };
  return { accepted: true, body: args.response.body, receipt: verification.receipt, outcome };
}

