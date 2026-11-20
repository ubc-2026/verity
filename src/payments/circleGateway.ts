import type { Hex } from "viem";
import type { ResearchRequestV1 } from "./researchRequest.ts";

/**
 * Circle Gateway (nanopayments) as an opt-in payment rail on Arc Testnet.
 *
 * The buyer signs an EIP-3009 TransferWithAuthorization under the Gateway
 * batching domain instead of the USDC token domain. The merchant submits it
 * to Circle's facilitator (verify, then settle); Gateway accepts it at once
 * and settles it later inside a batch transaction. Shapes follow the official
 * `@circle-fin/x402-batching` 4.0.0 SDK and circlefin/arc-nanopayments
 * (`lib/x402.ts`).
 */
export type PaymentRail = "arc-eip3009" | "circle-gateway-batched";

export const ARC_TESTNET_NETWORK = "eip155:5042002";
/** Circle contract-addresses page, testnet, domain 26. */
export const ARC_TESTNET_GATEWAY_WALLET: Hex = "0x0077777d7eba4688bdef3e311b846f25870a19b9";
/**
 * Circle Gateway testnet API. BatchFacilitatorClient defaults to the mainnet host
 * (https://gateway-api.circle.com), which answers `unsupported_network` for Arc Testnet;
 * the SDK's GatewayClient uses this host for testnet chains. The client appends /v1/x402/*.
 */
export const ARC_TESTNET_GATEWAY_API = "https://gateway-api-testnet.circle.com";
export const GATEWAY_BATCHING_NAME = "GatewayWalletBatched";
/** Version 1 is the USDC batching domain in the SDK (version 2 adds a salt and is for other assets). */
export const GATEWAY_BATCHING_VERSION = "1";
/** SDK constant GATEWAY_MIN_AUTH_VALIDITY_SECONDS (7 days) plus its 100 s buffer. */
export const GATEWAY_AUTH_VALIDITY_SECONDS = 7 * 24 * 60 * 60 + 100;
/** Official sample's maxTimeoutSeconds for the batched requirement. */
export const GATEWAY_MAX_TIMEOUT_SECONDS = 345_600;

export function gatewayAuthorizationDomain(verifyingContract: Hex = ARC_TESTNET_GATEWAY_WALLET) {
  return { name: GATEWAY_BATCHING_NAME, version: GATEWAY_BATCHING_VERSION, verifyingContract };
}

/** x402 v2 PaymentRequirements for one Verity request (same fields as the official sample). */
export interface GatewayRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; verifyingContract: string };
}

export interface GatewayPaymentPayload {
  x402Version: 2;
  resource: { url: string; description: string; mimeType: string };
  accepted: GatewayRequirements;
  payload: {
    authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
    signature: string;
  };
}

export function gatewayRequirements(request: ResearchRequestV1, verifyingContract: Hex = ARC_TESTNET_GATEWAY_WALLET): GatewayRequirements {
  return {
    scheme: "exact",
    network: `eip155:${request.chainId}`,
    asset: request.token,
    amount: request.amount,
    payTo: request.payTo,
    maxTimeoutSeconds: GATEWAY_MAX_TIMEOUT_SECONDS,
    extra: { name: GATEWAY_BATCHING_NAME, version: GATEWAY_BATCHING_VERSION, verifyingContract },
  };
}

export function gatewayPaymentPayload(
  request: ResearchRequestV1,
  authorization: { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex; signature: Hex },
  verifyingContract: Hex = ARC_TESTNET_GATEWAY_WALLET,
): GatewayPaymentPayload {
  const { signature, ...auth } = authorization;
  return {
    x402Version: 2,
    resource: { url: request.resourceUrl, description: `Verity evidence ${request.purchaseId}`, mimeType: request.contentType },
    accepted: gatewayRequirements(request, verifyingContract),
    payload: { authorization: auth, signature },
  };
}

export interface GatewayVerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}
export interface GatewaySettleResult {
  success: boolean;
  errorReason?: string;
  payer?: string;
  /** Facilitator's settlement reference. Circle does not document it as an onchain tx hash. */
  transaction: string;
}

/**
 * Settle `errorReason` values Circle documents on HTTP 200 as a definite rejection
 * (Settle an x402 payment). `nonce_already_used` is omitted: that nonce may already
 * belong to an accepted transfer, so the caller reconciles instead of releasing.
 * HTTP 500 is `unexpected_error`, which is not in this set. `BatchFacilitatorClient.callSettle`
 * returns any JSON body that contains `success` (including that 500) rather than throwing.
 */
const DETERMINISTIC_GATEWAY_SETTLE_REJECTIONS = new Set([
  "unsupported_scheme",
  "unsupported_network",
  "unsupported_asset",
  "invalid_payload",
  "address_mismatch",
  "amount_mismatch",
  "invalid_signature",
  "authorization_not_yet_valid",
  "authorization_expired",
  "authorization_validity_too_short",
  "self_transfer",
  "insufficient_balance",
  "unsupported_domain",
  "wallet_not_found",
]);

export function isDeterministicGatewayRejection(errorReason: string | undefined): boolean {
  return errorReason !== undefined && DETERMINISTIC_GATEWAY_SETTLE_REJECTIONS.has(errorReason);
}

/** Filters for Circle `searchTransfers`: one authorization, narrowed by its payer and recipient. */
export interface GatewayNonceLookup {
  nonce: Hex;
  from: Hex;
  to: Hex;
}
export type GatewayTransferStatus = "received" | "batched" | "confirmed" | "completed" | "failed";
/** Circle's per-payment record (`getTransferById`). `txHash` is the batch transaction once known. */
export interface GatewayTransfer {
  id: string;
  status: GatewayTransferStatus;
  amount: string;
  fromAddress: string;
  toAddress: string;
  nonce: string | null;
  txHash: string | null;
}

/** What Verity needs from Gateway. The fixture uses a mock; live wiring uses the official SDK. */
export interface GatewayProvider {
  readonly mode: "fixture" | "live";
  verify(payload: GatewayPaymentPayload, requirements: GatewayRequirements): Promise<GatewayVerifyResult>;
  settle(payload: GatewayPaymentPayload, requirements: GatewayRequirements): Promise<GatewaySettleResult>;
  /**
   * Per-payment record for one authorization.
   * Circle: searchTransfers({ nonce, from, to }). The caller still checks the nonce and a non-failed status.
   */
  transferByNonce(lookup: GatewayNonceLookup): Promise<GatewayTransfer | undefined>;
  transferById(id: string): Promise<GatewayTransfer>;
}

function toTransfer(raw: Record<string, unknown>): GatewayTransfer {
  return {
    id: String(raw.id),
    status: raw.status as GatewayTransferStatus,
    amount: String(raw.amount),
    fromAddress: String(raw.fromAddress),
    toAddress: String(raw.toAddress),
    nonce: typeof raw.nonce === "string" ? raw.nonce : null,
    txHash: typeof raw.txHash === "string" && raw.txHash ? raw.txHash : null,
  };
}

/**
 * Live provider, opt-in only. It is built only when VERITY_PAYMENT_RAIL=circle-gateway-batched
 * and a seller key is supplied by the caller; this module never reads a key itself.
 * Not exercised by any test or fixture command; used only by the LIVE runner scripts/arc-gateway.ts.
 */
export async function createLiveGatewayProvider(args: { sellerPrivateKey: Hex; rpcUrl?: string }): Promise<GatewayProvider> {
  const server = await import("@circle-fin/x402-batching/server");
  const client = await import("@circle-fin/x402-batching/client");
  const facilitator = new server.BatchFacilitatorClient({ url: ARC_TESTNET_GATEWAY_API });
  const seller = new client.GatewayClient({ chain: "arcTestnet", privateKey: args.sellerPrivateKey, ...(args.rpcUrl ? { rpcUrl: args.rpcUrl } : {}) });
  return {
    mode: "live",
    verify: (payload, requirements) => facilitator.verify(payload as never, requirements as never) as Promise<GatewayVerifyResult>,
    settle: (payload, requirements) => facilitator.settle(payload as never, requirements as never) as Promise<GatewaySettleResult>,
    async transferByNonce(lookup) {
      const { transfers } = await seller.searchTransfers({
        nonce: lookup.nonce,
        from: lookup.from,
        to: lookup.to,
        pageSize: 10,
      });
      const match = ((transfers ?? []) as Record<string, unknown>[]).find(
        (row) => typeof row.nonce === "string" && row.nonce.toLowerCase() === lookup.nonce.toLowerCase(),
      );
      return match ? toTransfer(match) : undefined;
    },
    async transferById(id) {
      return toTransfer((await seller.getTransferById(id)) as Record<string, unknown>);
    },
  };
}
