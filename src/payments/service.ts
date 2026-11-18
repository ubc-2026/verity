import type { Hex } from "viem";
import { RESEARCH_RESOURCES, resourceByHash, resourceById } from "./catalog.ts";
import { AuditLedger } from "./ledger.ts";
import { verifyPaidRequest, type Eip3009Authorization, type MerchantConfig, type PaidRequest, type SavedQuote } from "./merchant.ts";
import { parseQuote, type VerityQuote } from "./quote.ts";
import { classifyVerifyFailure, reportNonceReplay, reportVerified, reportWrongResource, type VerificationReport } from "./report.ts";
import { hashContent, parseResearchParameters, ResearchRequestError } from "./researchRequest.ts";
import { sealDelivery, verifyDelivery, type ReceiptSigner } from "./receipt.ts";

export interface QuoteRequest {
  catalogItemId: string;
  purchaseId: string;
  buyerSessionId: string;
  parameters: unknown;
  catalogParameters?: Record<string, string>;
}

/**
 * Mock merchant. It quotes fixture documents, checks the payment commitment,
 * and remembers each accepted authorization nonce. Accepting a payment here
 * is a local decision. Nothing is submitted to Arc.
 */
export class MerchantService {
  readonly ledger = new AuditLedger();
  readonly #quotes = new Map<string, SavedQuote>();
  readonly #spent = new Map<string, string>();
  readonly #config: MerchantConfig;
  readonly #signer: ReceiptSigner;
  readonly #now: () => number;
  readonly #quoteTtlSeconds: number;

  constructor(options: { config: MerchantConfig; signer: ReceiptSigner; now: () => number; quoteTtlSeconds?: number }) {
    this.#config = options.config;
    this.#signer = options.signer;
    this.#now = options.now;
    this.#quoteTtlSeconds = options.quoteTtlSeconds ?? 600;
  }

  listCatalog() {
    return RESEARCH_RESOURCES.map((resource) => ({
      catalogItemId: resource.item.catalogItemId,
      title: resource.title,
      price: resource.item.price.toString(10),
      resourceUrl: resource.item.resourceUrl,
      evidenceType: resource.item.evidenceType,
      requiredParameters: resource.item.requiredParameters,
      contentHash: hashContent(resource.body),
    }));
  }

  issueQuote(input: QuoteRequest): SavedQuote {
    const resource = resourceById(input.catalogItemId);
    if (!resource) throw new ResearchRequestError(`unknown catalog item: ${input.catalogItemId}`);
    if (resource.item.affects !== "resolution_risk") {
      throw new ResearchRequestError("this merchant does not sell outcome forecasts");
    }
    const parameters = parseResearchParameters(input.parameters);
    if (parameters.evidenceType !== resource.item.evidenceType) {
      throw new ResearchRequestError("evidenceType does not match the catalog item");
    }

    const provided = input.catalogParameters ?? {};
    const keys = Object.keys(provided).sort();
    const required = [...resource.item.requiredParameters].sort();
    if (keys.join("|") !== required.join("|")) {
      throw new ResearchRequestError(`catalog parameters must be ${required.join(", ") || "(none)"}`);
    }
    if (resource.sampleParameters) {
      for (const [key, value] of Object.entries(resource.sampleParameters)) {
        if (provided[key] !== value) throw new ResearchRequestError(`no fixture document for ${key}`);
      }
    }

    const quoteId = input.purchaseId.startsWith("purchase-")
      ? `quote-${input.purchaseId.slice("purchase-".length)}`
      : `quote-${input.purchaseId}`;
    if (this.#quotes.has(quoteId)) throw new ResearchRequestError(`quote already issued: ${quoteId}`);

    const quote = parseQuote({
      quoteId,
      purchaseId: input.purchaseId,
      merchantId: this.#config.merchantId,
      catalogItemId: resource.item.catalogItemId,
      method: "POST",
      resourceUrl: resource.item.resourceUrl,
      parameters,
      contentType: resource.item.contentType,
      expectedContentHash: hashContent(resource.body),
      chainId: this.#config.chainId,
      token: this.#config.token,
      payTo: this.#config.payTo,
      amount: resource.item.price.toString(10),
      expiresAt: this.#now() + this.#quoteTtlSeconds,
      ...(keys.length > 0 ? { catalogParameters: provided } : {}),
    });
    const saved: SavedQuote = { ...quote, buyerSessionId: input.buyerSessionId };
    this.#quotes.set(quote.quoteId, saved);
    return saved;
  }

  /** Check the commitment. On success, spend the nonce and return the document. */
  async verify(input: PaidRequest): Promise<VerificationReport> {
    const verified = await verifyPaidRequest(input, {
      config: this.#config,
      loadQuote: (quoteId) => this.#quotes.get(quoteId),
      hasArtifact: (contentHash) => resourceByHash(contentHash) !== undefined,
      now: this.#now,
    });
    if (!verified.ok) {
      const report = classifyVerifyFailure(verified);
      const purchaseId = readPurchaseId(input);
      if (purchaseId) this.ledger.noteMismatch(purchaseId, report.reason ?? verified.reason);
      return report;
    }

    const nonceKey = spentKey(input.authorization);
    if (this.#spent.has(nonceKey)) {
      this.ledger.noteDuplicate(verified.request.purchaseId, "the same authorization was submitted again");
      const report = reportNonceReplay();
      report.requestHash = verified.requestHash;
      report.nonce = verified.nonce;
      return report;
    }

    const resource = resourceByHash(verified.request.expectedContentHash);
    if (!resource) {
      this.ledger.noteMismatch(verified.request.purchaseId, "quoted artifact is not in the catalog");
      return reportWrongResource("quoted artifact is not in the catalog");
    }

    const sealed = await sealDelivery(
      {
        body: resource.body,
        expectedContentHash: verified.request.expectedContentHash,
        purchaseId: verified.request.purchaseId,
        quoteId: verified.request.quoteId,
        requestHash: verified.requestHash,
        nonce: verified.nonce,
        resourceUrl: verified.request.resourceUrl,
        chainId: verified.request.chainId,
      },
      this.#signer,
    );
    this.#spent.set(nonceKey, verified.request.purchaseId);
    this.ledger.notePayment(verified.request.purchaseId, {
      requestHash: verified.requestHash,
      nonce: verified.nonce,
      amount: verified.request.amount,
    });
    this.ledger.noteDelivery(verified.request.purchaseId, { ok: true, detail: "delivery receipt matches the quoted bytes" });
    return reportVerified({
      requestHash: verified.requestHash,
      nonce: verified.nonce,
      resourceId: resource.item.catalogItemId,
      contentType: resource.item.contentType,
      body: new TextDecoder().decode(sealed.body),
      contentHash: sealed.receipt.contentHash,
      receipt: sealed.receipt,
      receiptSignature: sealed.signature,
    });
  }

  /**
   * The authorization is for one document. The bytes offered as the delivery
   * are a different document. The buyer rejects them, and the nonce stays unused.
   */
  async attackWrongResource(input: PaidRequest, wrongCatalogItemId: string): Promise<VerificationReport> {
    const verified = await verifyPaidRequest(input, {
      config: this.#config,
      loadQuote: (quoteId) => this.#quotes.get(quoteId),
      hasArtifact: (contentHash) => resourceByHash(contentHash) !== undefined,
      now: this.#now,
    });
    if (!verified.ok) return { ...classifyVerifyFailure(verified), simulation: "wrong-resource" };

    const honest = resourceByHash(verified.request.expectedContentHash);
    const wrong = resourceById(wrongCatalogItemId);
    if (!honest || !wrong) throw new ResearchRequestError("attack resources are not both in the catalog");
    const sealed = await sealDelivery(
      {
        body: honest.body,
        expectedContentHash: verified.request.expectedContentHash,
        purchaseId: verified.request.purchaseId,
        quoteId: verified.request.quoteId,
        requestHash: verified.requestHash,
        nonce: verified.nonce,
        resourceUrl: verified.request.resourceUrl,
        chainId: verified.request.chainId,
      },
      this.#signer,
    );
    const check = await verifyDelivery({
      body: wrong.body,
      receipt: sealed.receipt,
      signature: sealed.signature,
      merchant: this.#signer.address,
      chainId: this.#config.chainId,
      expectedContentHash: verified.request.expectedContentHash,
      requestHash: verified.requestHash,
    });
    const report = reportWrongResource(check.ok ? "buyer accepted swapped bytes" : check.reason);
    report.simulation = "wrong-resource";
    report.requestHash = verified.requestHash;
    report.nonce = verified.nonce;
    this.ledger.noteMismatch(verified.request.purchaseId, "delivered bytes do not match the quoted document");
    return report;
  }

  async attackChangedUrl(input: PaidRequest, target: string): Promise<VerificationReport> {
    const report = await this.verify({ ...input, target });
    return { ...report, simulation: "changed-url" };
  }

  async attackDuplicate(input: PaidRequest): Promise<VerificationReport> {
    const report = await this.verify(input);
    return { ...report, simulation: "duplicate" };
  }
}

export function savedQuoteWire(quote: SavedQuote): VerityQuote {
  const { buyerSessionId: _session, ...wire } = quote;
  return wire;
}

function spentKey(authorization: Eip3009Authorization): string {
  return `${authorization.from.toLowerCase()}:${authorization.nonce.toLowerCase()}`;
}

function readPurchaseId(input: PaidRequest): string | null {
  if (!input.bindingHeader) return null;
  try {
    const parsed = JSON.parse(input.bindingHeader) as { purchaseId?: unknown };
    return typeof parsed.purchaseId === "string" ? parsed.purchaseId : null;
  } catch {
    return null;
  }
}
