import canonicalize from "canonicalize";
import { recoverTypedDataAddress, type Hex } from "viem";
import { parseBindingHeader } from "./binding.ts";
import type { VerityQuote } from "./quote.ts";
import {
  deriveNonce,
  computeRequestHash,
  parseResearchParameters,
  parseResearchRequest,
  RESEARCH_REQUEST_VERSION,
  type ResearchRequestV1,
} from "./researchRequest.ts";
import { parseStrictJson } from "./strictJson.ts";

export interface MerchantConfig {
  /** Configured HTTPS origin. Never taken from the Host header. */
  origin: string;
  merchantId: string;
  chainId: number;
  token: Hex;
  payTo: Hex;
  /** The token's EIP-712 domain. Arc Testnet USDC values are pending qualification. */
  tokenDomain: { name: string; version: string };
  maxAuthorizationWindowSeconds: number;
}

export interface SavedQuote extends VerityQuote {
  buyerSessionId: string;
}

/** EIP-3009 TransferWithAuthorization fields from the x402 payment payload. */
export interface Eip3009Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
}

export interface PaidRequest {
  method: string;
  /** Request target exactly as received, e.g. "/evidence/resolution-source". */
  target: string;
  body: Uint8Array;
  bindingHeader: string | undefined;
  buyerSessionId: string;
  /** Network and asset declared by the x402 payload. */
  chainId: number;
  token: Hex;
  authorization: Eip3009Authorization;
}

export interface MerchantDeps {
  config: MerchantConfig;
  loadQuote(quoteId: string): SavedQuote | undefined | Promise<SavedQuote | undefined>;
  hasArtifact(contentHash: Hex): boolean | Promise<boolean>;
  now(): number;
}

export type VerifyResult =
  | { ok: true; request: ResearchRequestV1; requestHash: Hex; nonce: Hex }
  | { ok: false; status: 400 | 402 | 403 | 404 | 410 | 503; reason: string };

const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const fail = (status: Extract<VerifyResult, { ok: false }>["status"], reason: string): VerifyResult => ({
  ok: false,
  status,
  reason,
});

const lower = (value: string) => value.toLowerCase();
const isUintString = (value: string) => /^(0|[1-9][0-9]*)$/.test(value);

/**
 * Merchant-side verification. Rebuilds ResearchRequestV1 from the saved quote,
 * the actual route and body, and the signed authorization, then checks the
 * derived nonce and every payment field. Nothing here settles.
 */
export async function verifyPaidRequest(input: PaidRequest, deps: MerchantDeps): Promise<VerifyResult> {
  const { config } = deps;
  const auth = input.authorization;

  let binding;
  try {
    binding = parseBindingHeader(input.bindingHeader);
  } catch (error) {
    return fail(400, (error as Error).message);
  }

  const quote = await deps.loadQuote(binding.quoteId);
  if (!quote) return fail(404, "unknown quote");
  if (quote.purchaseId !== binding.purchaseId) return fail(402, "binding purchaseId does not match quote");
  if (quote.buyerSessionId !== input.buyerSessionId) return fail(403, "quote belongs to another buyer session");
  if (quote.merchantId !== config.merchantId) return fail(402, "quote issued for another merchant");

  // Route: configured origin + exact path, POST only, no query or fragment.
  if (input.method !== "POST") return fail(402, "method does not match quote");
  if (!input.target.startsWith("/") || /[?#]/.test(input.target)) return fail(400, "invalid request target");
  const resourceUrl = new URL(input.target, config.origin).href;
  if (resourceUrl !== `${config.origin}${input.target}`) return fail(400, "non-canonical request target");
  if (resourceUrl !== quote.resourceUrl) return fail(402, "route does not match quote");

  // Body: strict JSON, strict parameter schema, must equal the quoted parameters.
  let parameters;
  try {
    parameters = parseResearchParameters(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(input.body)));
  } catch (error) {
    return fail(400, `invalid body: ${(error as Error).message}`);
  }
  if (canonicalize(parameters) !== canonicalize(quote.parameters)) return fail(402, "body does not match quote");

  // Payment fields against configuration and quote.
  if (input.chainId !== config.chainId || quote.chainId !== config.chainId) return fail(402, "network mismatch");
  if (lower(input.token) !== lower(config.token) || lower(quote.token) !== lower(config.token)) {
    return fail(402, "token mismatch");
  }
  if (lower(auth.to) !== lower(config.payTo) || lower(quote.payTo) !== lower(config.payTo)) {
    return fail(402, "recipient mismatch");
  }
  if (!isUintString(auth.value) || auth.value !== quote.amount) return fail(402, "amount mismatch");
  if (!isUintString(auth.validAfter) || !isUintString(auth.validBefore)) return fail(400, "invalid validity window");

  const validAfter = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);
  const now = deps.now();
  if (!Number.isSafeInteger(validAfter) || !Number.isSafeInteger(validBefore)) return fail(400, "validity out of range");
  if (validBefore - validAfter > config.maxAuthorizationWindowSeconds) return fail(402, "authorization window too long");
  if (now <= validAfter || now >= validBefore) return fail(402, "authorization not currently valid");
  if (now >= quote.expiresAt) return fail(410, "quote expired");

  // Rebuild and commit. Values come from the quote, route, body, and authorization.
  let request: ResearchRequestV1;
  try {
    request = parseResearchRequest({
      version: RESEARCH_REQUEST_VERSION,
      purchaseId: quote.purchaseId,
      quoteId: quote.quoteId,
      merchantId: config.merchantId,
      method: input.method,
      resourceUrl,
      parameters,
      contentType: quote.contentType,
      expectedContentHash: quote.expectedContentHash,
      chainId: config.chainId,
      token: config.token,
      payer: auth.from,
      payTo: config.payTo,
      amount: quote.amount,
      validAfter,
      validBefore,
    });
  } catch (error) {
    return fail(402, `request rebuild failed: ${(error as Error).message}`);
  }
  const requestHash = computeRequestHash(request);
  const nonce = deriveNonce(requestHash, binding.salt);
  if (lower(auth.nonce) !== nonce) return fail(402, "nonce does not commit to this request");

  let signer: Hex;
  try {
    signer = await recoverTypedDataAddress({
      domain: { ...config.tokenDomain, chainId: config.chainId, verifyingContract: config.token },
      types: transferWithAuthorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce: auth.nonce,
      },
      signature: auth.signature,
    });
  } catch {
    return fail(402, "malformed authorization signature");
  }
  if (lower(signer) !== request.payer) return fail(402, "signature does not match payer");

  if (!(await deps.hasArtifact(request.expectedContentHash))) return fail(503, "quoted artifact unavailable");

  return { ok: true, request, requestHash, nonce };
}

export interface SettlementAdapter {
  settle(verified: Extract<VerifyResult, { ok: true }>, authorization: Eip3009Authorization): Promise<unknown>;
}

/** Merchant path: the binding is checked before the settlement adapter is called. */
export async function handlePaidRequest(
  input: PaidRequest,
  deps: MerchantDeps & { settlement: SettlementAdapter },
): Promise<{ verified: VerifyResult; settlement?: unknown }> {
  const verified = await verifyPaidRequest(input, deps);
  if (!verified.ok) return { verified };
  return { verified, settlement: await deps.settlement.settle(verified, input.authorization) };
}
