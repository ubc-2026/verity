import { recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import { hashContent, ResearchRequestError } from "./researchRequest.ts";

export const DELIVERY_RECEIPT_VERSION = "verity-delivery-receipt-v1";

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);

export const deliveryReceiptSchema = z.strictObject({
  version: z.literal(DELIVERY_RECEIPT_VERSION),
  purchaseId: z.string().min(1),
  quoteId: z.string().min(1),
  requestHash: bytes32,
  nonce: bytes32,
  contentHash: bytes32,
  resourceUrl: z.string().min(1),
});

export type DeliveryReceiptV1 = z.output<typeof deliveryReceiptSchema>;

export const deliveryReceiptTypes = {
  DeliveryReceipt: [
    { name: "purchaseId", type: "string" },
    { name: "quoteId", type: "string" },
    { name: "requestHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "contentHash", type: "bytes32" },
    { name: "resourceUrl", type: "string" },
  ],
} as const;

export function deliveryDomain(chainId: number, merchant: Hex) {
  return { name: "Verity Delivery", version: "1", chainId, verifyingContract: merchant } as const;
}

export interface ReceiptSigner {
  address: Hex;
  signTypedData(parameters: {
    domain: ReturnType<typeof deliveryDomain>;
    types: typeof deliveryReceiptTypes;
    primaryType: "DeliveryReceipt";
    message: {
      purchaseId: string;
      quoteId: string;
      requestHash: Hex;
      nonce: Hex;
      contentHash: Hex;
      resourceUrl: string;
    };
  }): Promise<Hex>;
}

export interface SealedDelivery {
  body: Uint8Array;
  receipt: DeliveryReceiptV1;
  signature: Hex;
}

/**
 * Hash the raw bytes first. The merchant signs that digest and refuses to
 * sign a body that is not the one the quote promised.
 */
export async function sealDelivery(
  input: {
    body: Uint8Array;
    expectedContentHash: Hex;
    purchaseId: string;
    quoteId: string;
    requestHash: Hex;
    nonce: Hex;
    resourceUrl: string;
    chainId: number;
  },
  signer: ReceiptSigner,
): Promise<SealedDelivery> {
  const contentHash = hashContent(input.body);
  if (contentHash !== input.expectedContentHash.toLowerCase()) {
    throw new ResearchRequestError("refusing to sign a delivery whose bytes do not match the quote");
  }
  const receipt = deliveryReceiptSchema.parse({
    version: DELIVERY_RECEIPT_VERSION,
    purchaseId: input.purchaseId,
    quoteId: input.quoteId,
    requestHash: input.requestHash,
    nonce: input.nonce,
    contentHash,
    resourceUrl: input.resourceUrl,
  });
  const signature = await signer.signTypedData({
    domain: deliveryDomain(input.chainId, signer.address),
    types: deliveryReceiptTypes,
    primaryType: "DeliveryReceipt",
    message: {
      purchaseId: receipt.purchaseId,
      quoteId: receipt.quoteId,
      requestHash: receipt.requestHash,
      nonce: receipt.nonce,
      contentHash: receipt.contentHash,
      resourceUrl: receipt.resourceUrl,
    },
  });
  return { body: input.body, receipt, signature };
}

export type DeliveryCheck =
  | { ok: true; contentHash: Hex; receipt: DeliveryReceiptV1 }
  | { ok: false; reason: "wrong_resource" | "invalid_receipt" | "merchant_mismatch" | "request_mismatch" };

/**
 * Buyer side. Hash the raw response before parsing it, then check the receipt
 * signature against the pinned merchant key.
 */
export async function verifyDelivery(input: {
  body: Uint8Array;
  receipt: unknown;
  signature: Hex;
  merchant: Hex;
  chainId: number;
  expectedContentHash: Hex;
  requestHash: Hex;
}): Promise<DeliveryCheck> {
  const contentHash = hashContent(input.body);
  const parsed = deliveryReceiptSchema.safeParse(input.receipt);
  if (!parsed.success) return { ok: false, reason: "invalid_receipt" };
  const receipt = parsed.data;
  if (contentHash !== receipt.contentHash || contentHash !== input.expectedContentHash.toLowerCase()) {
    return { ok: false, reason: "wrong_resource" };
  }
  if (receipt.requestHash !== input.requestHash.toLowerCase()) return { ok: false, reason: "request_mismatch" };

  let signer: Hex;
  try {
    signer = await recoverTypedDataAddress({
      domain: deliveryDomain(input.chainId, input.merchant),
      types: deliveryReceiptTypes,
      primaryType: "DeliveryReceipt",
      message: {
        purchaseId: receipt.purchaseId,
        quoteId: receipt.quoteId,
        requestHash: receipt.requestHash,
        nonce: receipt.nonce,
        contentHash: receipt.contentHash,
        resourceUrl: receipt.resourceUrl,
      },
      signature: input.signature,
    });
  } catch {
    return { ok: false, reason: "invalid_receipt" };
  }
  if (signer.toLowerCase() !== input.merchant.toLowerCase()) return { ok: false, reason: "merchant_mismatch" };
  return { ok: true, contentHash, receipt };
}
