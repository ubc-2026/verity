import canonicalize from "canonicalize";
import type { Hex } from "viem";
import { encodeBindingHeader } from "./binding.ts";
import type { VerityQuote } from "./quote.ts";
import {
  ResearchRequestError,
  commitResearchRequest,
  computeRequestHash,
  fromBaseUnits,
  generateSalt,
  parseResearchParameters,
  parseResearchRequest,
  RESEARCH_REQUEST_VERSION,
  type RequestCommitment,
  type ResearchRequestV1,
} from "./researchRequest.ts";

/** Trusted, allowlisted catalog entry. Comes from configuration, never from the model. */
export interface CatalogItem {
  catalogItemId: string;
  merchantId: string;
  resourceUrl: string;
  method: "POST";
  contentType: string;
  chainId: number;
  token: Hex;
  payTo: Hex;
  /** Hard price ceiling for this item, in USDC base units. */
  maxAmount: bigint;
  /** Listed price the mock merchant quotes, in USDC base units. */
  price: bigint;
  evidenceType: string;
  /** Resolution evidence can be purchased. Outcome forecasts cannot. */
  affects: "resolution_risk" | "outcome_probability";
  /** Catalog parameter names the merchant requires besides contractId. */
  requiredParameters: readonly string[];
  /** Payment rail; absent means the direct EIP-3009 rail. */
  rail?: "arc-eip3009" | "circle-gateway-batched";
}

/**
 * The fields of the purchase-decisions `PurchaseProposalV1` this slice reads.
 * The model may choose the item and parameters and set a ceiling; nothing else.
 */
export interface ProposalSelection {
  catalogItemId: string;
  parameters: unknown;
  maxAmount: bigint;
}

export interface BuildRequestInput {
  catalog: ReadonlyMap<string, CatalogItem>;
  proposal: ProposalSelection;
  /** Already parsed with `parseQuote`. */
  quote: VerityQuote;
  /** Purchase ID the buyer generated before asking for the quote. The quote must echo it. */
  purchaseId: string;
  /**
   * Catalog parameters derived from the contract (station and date, for example).
   * When the item declares parameters, the quote must carry exactly these values.
   */
  catalogParameters?: Readonly<Record<string, string>>;
  payer: Hex;
  /** Current UTC epoch seconds. */
  now: number;
  /** Authorization lifetime. Kept short; capped by quote expiry. */
  windowSeconds?: number;
  /** Backdating of validAfter to tolerate chain clock skew. */
  clockSkewSeconds?: number;
  /** Gateway rail only: the authorization window may run past quote expiry (Circle requires 7 days). */
  allowBeyondQuoteExpiry?: boolean;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Buyer-side construction. The endpoint, token, recipient, and chain come from
 * the trusted catalog; the price, IDs, and content hash come from the validated
 * quote, which must agree with the catalog and stay within both ceilings.
 */
export function buildResearchRequest(input: BuildRequestInput): ResearchRequestV1 {
  const { catalog, proposal, quote, payer, now } = input;
  const windowSeconds = input.windowSeconds ?? 300;
  const clockSkewSeconds = input.clockSkewSeconds ?? 30;

  const item = catalog.get(proposal.catalogItemId);
  if (!item) throw new ResearchRequestError(`catalog item not allowlisted: ${proposal.catalogItemId}`);

  const mismatches: string[] = [];
  if (quote.catalogItemId !== item.catalogItemId) mismatches.push("catalogItemId");
  if (quote.merchantId !== item.merchantId) mismatches.push("merchantId");
  if (quote.resourceUrl !== item.resourceUrl) mismatches.push("resourceUrl");
  if (quote.method !== item.method) mismatches.push("method");
  if (quote.contentType !== item.contentType) mismatches.push("contentType");
  if (quote.chainId !== item.chainId) mismatches.push("chainId");
  if (!sameAddress(quote.token, item.token)) mismatches.push("token");
  if (!sameAddress(quote.payTo, item.payTo)) mismatches.push("payTo");
  const parameters = parseResearchParameters(proposal.parameters);
  if (canonicalize(parameters) !== canonicalize(quote.parameters)) mismatches.push("parameters");
  if (quote.purchaseId !== input.purchaseId) mismatches.push("purchaseId");
  const wanted = input.catalogParameters ?? {};
  const required = item.requiredParameters ?? [];
  for (const name of required) {
    if (!wanted[name]) throw new ResearchRequestError(`catalog parameter ${name} is missing or empty`);
  }
  const extra = Object.keys(wanted).filter((name) => !required.includes(name));
  if (extra.length > 0) throw new ResearchRequestError(`catalog parameters not declared by the item: ${extra.join(", ")}`);
  if (canonicalize(wanted) !== canonicalize(quote.catalogParameters ?? {})) mismatches.push("catalogParameters");
  if (mismatches.length > 0) {
    throw new ResearchRequestError(`quote disagrees with catalog or proposal: ${mismatches.join(", ")}`);
  }

  const amount = fromBaseUnits(quote.amount);
  if (amount > item.maxAmount) throw new ResearchRequestError("quote exceeds catalog price ceiling");
  if (amount > proposal.maxAmount) throw new ResearchRequestError("quote exceeds proposal price ceiling");
  if (quote.expiresAt <= now) throw new ResearchRequestError("quote expired");

  const validBefore = input.allowBeyondQuoteExpiry ? now + windowSeconds : Math.min(now + windowSeconds, quote.expiresAt);
  return parseResearchRequest({
    version: RESEARCH_REQUEST_VERSION,
    purchaseId: input.purchaseId,
    quoteId: quote.quoteId,
    merchantId: item.merchantId,
    method: item.method,
    resourceUrl: item.resourceUrl,
    parameters,
    contentType: item.contentType,
    expectedContentHash: quote.expectedContentHash,
    chainId: item.chainId,
    token: item.token,
    payer,
    payTo: item.payTo,
    amount: quote.amount,
    validAfter: Math.max(0, now - clockSkewSeconds),
    validBefore,
  });
}

export interface AuthorizationRecord extends RequestCommitment {
  purchaseId: string;
  request: ResearchRequestV1;
}

/**
 * Persists the authorization identity per purchase. The in-memory store is a
 * local fixture; the payment service needs a durable, transactional store.
 */
export interface AuthorizationStore {
  get(purchaseId: string): AuthorizationRecord | undefined;
  /** Inserts if absent and returns whichever record is stored. */
  insertIfAbsent(record: AuthorizationRecord): AuthorizationRecord;
}

export class InMemoryAuthorizationStore implements AuthorizationStore {
  readonly #records = new Map<string, AuthorizationRecord>();
  get(purchaseId: string) {
    return this.#records.get(purchaseId);
  }
  insertIfAbsent(record: AuthorizationRecord) {
    const existing = this.#records.get(record.purchaseId);
    if (existing) return existing;
    this.#records.set(record.purchaseId, record);
    return record;
  }
}

export interface PreparedAuthorization {
  record: AuthorizationRecord;
  /** True when an existing authorization was returned for an idempotent retry. */
  reused: boolean;
  bindingHeader: string;
}

/**
 * Generates a fresh salt for a new purchase, or returns the stored salt and
 * nonce for a retry of the identical request. A different request under the
 * same purchase ID is refused: one purchase never gets a second authorization.
 */
export function prepareAuthorization(
  request: ResearchRequestV1,
  store: AuthorizationStore,
  saltSource: () => Hex = generateSalt,
): PreparedAuthorization {
  const requestHash = computeRequestHash(request);
  const existing = store.get(request.purchaseId);
  const record =
    existing ??
    store.insertIfAbsent({ purchaseId: request.purchaseId, request, ...commitResearchRequest(request, saltSource()) });

  if (record.requestHash !== requestHash) {
    throw new ResearchRequestError(
      `purchase ${request.purchaseId} already has an authorization for a different request`,
    );
  }
  return {
    record,
    reused: existing !== undefined,
    bindingHeader: encodeBindingHeader({
      purchaseId: record.purchaseId,
      quoteId: record.request.quoteId,
      salt: record.salt,
    }),
  };
}
