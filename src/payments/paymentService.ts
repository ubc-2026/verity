import type { Hex } from "viem";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "./arc.ts";
import { encodeBindingHeader } from "./binding.ts";
import { gatewayAuthorizationDomain } from "./circleGateway.ts";
import type { Eip3009Authorization } from "./merchant.ts";
import { ApprovalRequiredError, type PaymentStore, type StoredAuthorization } from "./store.ts";

/** The signer stays behind the payment service. Only typed-data signing is needed. */
export interface PaymentSigner {
  address: Hex;
  signTypedData(args: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
    types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
    primaryType: "TransferWithAuthorization";
    message: {
      from: Hex;
      to: Hex;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
      nonce: Hex;
    };
  }): Promise<Hex>;
}

export interface AuthorizedPayment {
  record: StoredAuthorization;
  authorization: Eip3009Authorization;
  bindingHeader: string;
  /** True when the stored signature was returned instead of signing again. */
  reused: boolean;
}

/**
 * Signs the EIP-3009 authorization from the durable record only. If a
 * signature is already stored for the purchase, it is returned unchanged:
 * a retry never produces a second authorization.
 */
export async function authorizeStoredPurchase(args: {
  store: PaymentStore;
  purchaseId: string;
  signer: PaymentSigner;
  tokenDomain: { name: string; version: string };
  now: number;
}): Promise<AuthorizedPayment> {
  // The signing domain follows the purchase's stored rail, so a retry signs (or reuses) under the same domain.
  const { store, purchaseId, signer } = args;
  let record = store.get(purchaseId);
  if (!record) throw new Error(`purchase ${purchaseId} has no recorded reservation; reserve before signing`);
  if (record.status === "awaiting_approval") {
    throw new ApprovalRequiredError(`purchase ${purchaseId} needs owner approval before signing`);
  }
  const reused = record.signature !== null;
  if (!reused) {
    const { request } = record;
    if (signer.address.toLowerCase() !== request.payer) throw new Error("signer is not the recorded payer");
    const signature = await signer.signTypedData({
      domain:
        record.rail === "circle-gateway-batched"
          ? { ...gatewayAuthorizationDomain(), chainId: request.chainId }
          : { ...args.tokenDomain, chainId: request.chainId, verifyingContract: request.token },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: request.payer,
        to: request.payTo,
        value: BigInt(request.amount),
        validAfter: BigInt(request.validAfter),
        validBefore: BigInt(request.validBefore),
        nonce: record.nonce,
      },
    });
    record = store.recordSignature(purchaseId, signature, args.now);
  }

  const { request } = record;
  return {
    record,
    reused,
    bindingHeader: encodeBindingHeader({ purchaseId, quoteId: request.quoteId, salt: record.salt }),
    authorization: {
      from: request.payer,
      to: request.payTo,
      value: request.amount,
      validAfter: String(request.validAfter),
      validBefore: String(request.validBefore),
      nonce: record.nonce,
      signature: record.signature!,
    },
  };
}
