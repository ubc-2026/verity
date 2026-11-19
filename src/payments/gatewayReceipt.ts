import canonicalize from "canonicalize";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import { RECEIPT_HEADER, type TrustedMerchant } from "./deliveryReceipt.ts";
import { computeRequestHash, hashContent, type ResearchRequestV1 } from "./researchRequest.ts";
import { parseStrictJson } from "./strictJson.ts";

/**
 * DeliveryReceiptV2 for the Circle Gateway rail. V1 signs an onchain tx hash,
 * which a Gateway payment does not have when it is accepted (it settles later
 * inside a batch). V2 signs the provider's per-payment identifier (Gateway
 * transfer UUID) and the authorization nonce instead, so the receipt ties
 * Verity's purchase ID to Circle's record of that one payment.
 */
export const GATEWAY_RECEIPT_VERSION = "verity-delivery-receipt-v2";
export const GATEWAY_RECEIPT_DOMAIN = { name: "VerityDeliveryReceipt", version: "2" } as const;
export const GATEWAY_RECEIPT_TYPES = {
  DeliveryReceipt: [
    { name: "version", type: "string" },
    { name: "merchantId", type: "string" },
    { name: "merchant", type: "address" },
    { name: "purchaseId", type: "string" },
    { name: "quoteId", type: "string" },
    { name: "requestHash", type: "bytes32" },
    { name: "contentHash", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "paymentRail", type: "string" },
    { name: "paymentRef", type: "string" },
    { name: "authorizationNonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v.toLowerCase() as Hex);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase() as Hex);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const gatewayReceiptSchema = z.strictObject({
  version: z.literal(GATEWAY_RECEIPT_VERSION),
  merchantId: identifier,
  merchant: address,
  purchaseId: identifier,
  quoteId: identifier,
  requestHash: bytes32,
  contentHash: bytes32,
  chainId: positiveInt,
  paymentRail: z.literal("circle-gateway-batched"),
  paymentRef: identifier,
  authorizationNonce: bytes32,
  issuedAt: positiveInt,
});
export const signedGatewayReceiptSchema = gatewayReceiptSchema.extend({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((v) => v.toLowerCase() as Hex),
});
export type GatewayReceipt = z.output<typeof gatewayReceiptSchema>;
export type SignedGatewayReceipt = z.output<typeof signedGatewayReceiptSchema>;

export interface GatewayReceiptSigner {
  address: Hex;
  signTypedData(args: {
    domain: typeof GATEWAY_RECEIPT_DOMAIN;
    types: typeof GATEWAY_RECEIPT_TYPES;
    primaryType: "DeliveryReceipt";
    message: ReturnType<typeof typedMessage>;
  }): Promise<Hex>;
}

function typedMessage(receipt: GatewayReceipt) {
  return { ...receipt, chainId: BigInt(receipt.chainId), issuedAt: BigInt(receipt.issuedAt) };
}

export function gatewayReceiptDigest(receipt: GatewayReceipt): Hex {
  return hashTypedData({ domain: GATEWAY_RECEIPT_DOMAIN, types: GATEWAY_RECEIPT_TYPES, primaryType: "DeliveryReceipt", message: typedMessage(receipt) });
}

export async function signGatewayReceipt(args: {
  signer: GatewayReceiptSigner;
  merchantId: string;
  request: ResearchRequestV1;
  paymentRef: string;
  authorizationNonce: Hex;
  issuedAt: number;
}): Promise<SignedGatewayReceipt> {
  const receipt = gatewayReceiptSchema.parse({
    version: GATEWAY_RECEIPT_VERSION,
    merchantId: args.merchantId,
    merchant: args.signer.address,
    purchaseId: args.request.purchaseId,
    quoteId: args.request.quoteId,
    requestHash: computeRequestHash(args.request),
    contentHash: args.request.expectedContentHash,
    chainId: args.request.chainId,
    paymentRail: "circle-gateway-batched",
    paymentRef: args.paymentRef,
    authorizationNonce: args.authorizationNonce,
    issuedAt: args.issuedAt,
  });
  const signature = await args.signer.signTypedData({
    domain: GATEWAY_RECEIPT_DOMAIN,
    types: GATEWAY_RECEIPT_TYPES,
    primaryType: "DeliveryReceipt",
    message: typedMessage(receipt),
  });
  return signedGatewayReceiptSchema.parse({ ...receipt, signature });
}

export function encodeGatewayReceiptHeader(receipt: SignedGatewayReceipt): string {
  return Buffer.from(canonicalize(receipt)!, "utf8").toString("base64url");
}

export type GatewayDeliveryRejection = "malformed_receipt" | "wrong_signer" | "binding_mismatch" | "content_mismatch" | "nonce_mismatch";
export type GatewayDeliveryVerification =
  | { ok: true; receipt: SignedGatewayReceipt; digest: Hex; contentHash: Hex }
  | { ok: false; code: GatewayDeliveryRejection; reason: string };

/**
 * Buyer side. Same order of checks as V1 `verifyDelivery`: strict parse, pinned
 * merchant key, binding to the buyer's stored request, keccak256 of the raw
 * bytes, then the authorization nonce the buyer itself signed.
 */
export async function verifyGatewayDelivery(args: {
  receiptHeader: string | undefined;
  body: Uint8Array;
  trusted: TrustedMerchant;
  request: ResearchRequestV1;
  authorizationNonce: Hex;
}): Promise<GatewayDeliveryVerification> {
  const reject = (code: GatewayDeliveryRejection, reason: string): GatewayDeliveryVerification => ({ ok: false, code, reason });
  const header = args.receiptHeader;
  if (!header || header.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(header)) return reject("malformed_receipt", `missing or malformed ${RECEIPT_HEADER}`);
  let receipt: SignedGatewayReceipt;
  try {
    const parsed = signedGatewayReceiptSchema.safeParse(
      parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(header, "base64url"))),
    );
    if (!parsed.success) return reject("malformed_receipt", `invalid receipt: ${parsed.error.issues[0]?.message}`);
    receipt = parsed.data;
  } catch (error) {
    return reject("malformed_receipt", `receipt is not strict JSON: ${(error as Error).message}`);
  }
  const { signature, ...unsigned } = receipt;
  let signer: Hex;
  try {
    signer = await recoverTypedDataAddress({
      domain: GATEWAY_RECEIPT_DOMAIN,
      types: GATEWAY_RECEIPT_TYPES,
      primaryType: "DeliveryReceipt",
      message: typedMessage(unsigned),
      signature,
    });
  } catch {
    return reject("malformed_receipt", "signature does not recover");
  }
  const pinned = args.trusted.receiptSigner.toLowerCase();
  if (signer.toLowerCase() !== pinned || receipt.merchant !== pinned) return reject("wrong_signer", `receipt signed by ${signer}`);
  const { request } = args;
  const bindings: Array<[string, unknown, unknown]> = [
    ["merchantId", receipt.merchantId, args.trusted.merchantId],
    ["purchaseId", receipt.purchaseId, request.purchaseId],
    ["quoteId", receipt.quoteId, request.quoteId],
    ["requestHash", receipt.requestHash, computeRequestHash(request)],
    ["chainId", receipt.chainId, request.chainId],
    ["contentHash", receipt.contentHash, request.expectedContentHash],
  ];
  const differing = bindings.filter(([, got, want]) => got !== want).map(([name]) => name);
  if (differing.length > 0) return reject("binding_mismatch", `receipt does not bind this request: ${differing.join(", ")}`);
  const contentHash = hashContent(args.body);
  if (contentHash !== receipt.contentHash) return reject("content_mismatch", `response bytes hash to ${contentHash}, receipt says ${receipt.contentHash}`);
  if (receipt.authorizationNonce !== args.authorizationNonce.toLowerCase()) return reject("nonce_mismatch", "receipt names a different authorization");
  return { ok: true, receipt, digest: gatewayReceiptDigest(unsigned), contentHash };
}
