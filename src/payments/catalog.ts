import type { Hex } from "viem";
import type { CatalogItem } from "./buyer.ts";
import { hashContent } from "./researchRequest.ts";

/** Public fixture configuration. Not a secret. */
export const MERCHANT_ORIGIN = "https://merchant.example";
export const MERCHANT_ID = "verity-demo-merchant";
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_USDC: Hex = "0x3600000000000000000000000000000000000000";
export const DEMO_PAY_TO: Hex = "0x2222222222222222222222222222222222222222";

/**
 * Pinned ResearchRequestV1 response bytes. No trailing newline.
 * keccak256 of these bytes is the fixture content hash.
 */
export const RESOLUTION_BODY_TEXT = `{"source":"mock","summary":"Cutoff policy excerpt for the demo."}`;
const PINNED_RESOLUTION_HASH: Hex = "0xecb8d0303298a3bff971405264cc3670f3297da1468bd6c39a3e32e5abd2dda9";

const text = (value: string) => new TextEncoder().encode(value);

export interface ResearchResource {
  title: string;
  /** UTF-8 document the merchant serves for this item. */
  body: Uint8Array;
  /** When set, a quote is issued only for this exact parameter set. */
  sampleParameters?: Readonly<Record<string, string>>;
  item: CatalogItem;
}

function item(
  partial: Pick<CatalogItem, "catalogItemId" | "resourceUrl" | "evidenceType" | "affects" | "price" | "maxAmount" | "requiredParameters"> &
    Pick<ResearchResource, "title" | "sampleParameters"> & { rail?: CatalogItem["rail"] },
  body: Uint8Array,
): ResearchResource {
  return {
    title: partial.title,
    body,
    sampleParameters: partial.sampleParameters,
    item: {
      catalogItemId: partial.catalogItemId,
      merchantId: MERCHANT_ID,
      resourceUrl: partial.resourceUrl,
      method: "POST",
      contentType: "application/json",
      chainId: ARC_TESTNET_CHAIN_ID,
      token: ARC_TESTNET_USDC,
      payTo: DEMO_PAY_TO,
      maxAmount: partial.maxAmount,
      price: partial.price,
      evidenceType: partial.evidenceType,
      affects: partial.affects,
      requiredParameters: partial.requiredParameters,
      ...(partial.rail ? { rail: partial.rail } : {}),
    },
  };
}

const resolutionBody = text(RESOLUTION_BODY_TEXT);
const resolutionHash = hashContent(resolutionBody);
if (resolutionHash !== PINNED_RESOLUTION_HASH) {
  throw new Error(`resolution fixture hash drifted: ${resolutionHash}`);
}

// FIXTURE document. It answers the observed open question (partial-day report vs full-day report, and
// corrections) in the shape analysis/verity/reassess.py reads. It is not an NWS or Gemini statement.
const nwsSettlementDocument = text(
  `{"label":"FIXTURE","source":"nws-cli","gap_type":"settlement_source_version","station":"Central Park, NY (CLINYC)","date":"2026-11-18","settling_issuance":"first_full_day_cli","excludes":["same-day partial CLINYC valid to 4 PM","later corrections"],"corrections_count":false,"summary":"FIXTURE: the first full-day CLINYC report for 2026-11-18 settles the contract. The same-day partial report and later corrections do not count."}`,
);

/** Allowlisted documents the mock merchant can sell. */
export const RESEARCH_RESOURCES: readonly ResearchResource[] = [
  item(
    {
      title: "Resolution-source excerpt",
      catalogItemId: "resolution-source-excerpt-v1",
      resourceUrl: `${MERCHANT_ORIGIN}/evidence/resolution-source`,
      evidenceType: "resolution_source",
      affects: "resolution_risk",
      price: 50_000n,
      maxAmount: 100_000n,
      requiredParameters: [],
    },
    resolutionBody,
  ),
  item(
    {
      title: "NWS daily climate report: settlement-version check",
      catalogItemId: "cat-nws-cli-settlement-version-v1",
      resourceUrl: `${MERCHANT_ORIGIN}/evidence/nws-cli-settlement`,
      evidenceType: "settlement_source_version",
      affects: "resolution_risk",
      price: 50_000n,
      maxAmount: 100_000n,
      requiredParameters: ["date", "station"],
      sampleParameters: { station: "Central Park, NY (CLINYC)", date: "2026-11-18" },
    },
    nwsSettlementDocument,

  ),
  item(
    {
      title: "NWS daily climate report: settlement-version check (Circle Gateway nanopayment)",
      catalogItemId: "cat-nws-cli-settlement-version-nano-v1",
      resourceUrl: `${MERCHANT_ORIGIN}/evidence/nws-cli-settlement-nano`,
      evidenceType: "settlement_source_version",
      affects: "resolution_risk",
      price: 1_000n, // 0.001 USDC
      maxAmount: 1_000n,
      requiredParameters: ["date", "station"],
      sampleParameters: { station: "Central Park, NY (CLINYC)", date: "2026-11-18" },
      rail: "circle-gateway-batched",
    },
    nwsSettlementDocument,
  ),
  item(
    {
      title: "Regulatory filing packet",
      catalogItemId: "cat-filing-packet-v1",
      resourceUrl: `${MERCHANT_ORIGIN}/evidence/filing-packet`,
      evidenceType: "regulatory_filing",
      affects: "resolution_risk",
      price: 800_000n,
      maxAmount: 2_000_000n,
      requiredParameters: [],
    },
    text(`{"source":"filing","summary":"Campaign-finance filing excerpt used as the priced owner-approval sample."}`),
  ),
  item(
    {
      title: "Oversized archive dump",
      catalogItemId: "cat-archive-dump-v1",
      resourceUrl: `${MERCHANT_ORIGIN}/evidence/archive-dump`,
      evidenceType: "archive_dump",
      affects: "resolution_risk",
      price: 2_500_000n,
      maxAmount: 3_000_000n,
      requiredParameters: [],
    },
    text(`{"source":"archive","summary":"Priced above the owner-approval maximum so policy rejects it."}`),
  ),
];

export const RESOLUTION_ITEM = RESEARCH_RESOURCES[0]!.item;

export function catalogById(): Map<string, CatalogItem> {
  return new Map(RESEARCH_RESOURCES.map((resource) => [resource.item.catalogItemId, resource.item]));
}

export function resourceById(catalogItemId: string): ResearchResource | undefined {
  return RESEARCH_RESOURCES.find((resource) => resource.item.catalogItemId === catalogItemId);
}

export function resourceByUrl(resourceUrl: string): ResearchResource | undefined {
  return RESEARCH_RESOURCES.find((resource) => resource.item.resourceUrl === resourceUrl);
}

export function resourceByHash(contentHash: Hex): ResearchResource | undefined {
  const want = contentHash.toLowerCase();
  return RESEARCH_RESOURCES.find((resource) => hashContent(resource.body) === want);
}
