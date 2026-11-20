import { z } from "zod";
import type { CatalogItem, ProposalSelection } from "./buyer.ts";
import { fromBaseUnits, parseResearchParameters, ResearchRequestError } from "./researchRequest.ts";

/**
 * PurchaseProposalV1 as emitted by the analysis slice. Unsigned. The payment
 * service copies the catalog item, contract, and ceiling from it and ignores
 * every other field when building the payment.
 */
export const purchaseProposalSchema = z.strictObject({
  version: z.literal("verity-purchase-proposal-v1"),
  proposal_id: z.string().min(1),
  contract_id: z.string().min(1),
  evidence_gap_id: z.string().min(1),
  catalog_item_id: z.string().min(1),
  /** Must equal the catalog item's evidence type; the payment never takes it from here alone. */
  evidence_type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  catalog_parameters: z.record(z.string(), z.string()),
  rationale: z.string().min(1),
  max_amount_base_units: z.string().regex(/^[1-9][0-9]*$/),
  asset: z.literal("USDC"),
  network_label: z.literal("arc-testnet"),
  fixture_label: z.string().nullable(),
  signed: z.literal(false),
  created_at_utc: z.string().min(1),
});

export type PurchaseProposalV1 = z.output<typeof purchaseProposalSchema>;

export interface AcceptedProposal {
  selection: ProposalSelection;
  groupKey: string;
  catalogParameters: Record<string, string>;
  /** A PurchaseProposalV1 is only emitted for a material gap with no free evidence. */
  materialUnresolvedGap: true;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((key, index) => key === b[index]);
}

/**
 * Turn an analysis proposal into the selection the buyer already knows how to
 * price. Forecast items are refused. Catalog parameters must be exactly the
 * names the allowlisted item declares.
 */
export function acceptPurchaseProposal(
  input: unknown,
  catalog: ReadonlyMap<string, CatalogItem>,
  /** The contract the person selected. A proposal for any other contract is refused. */
  options: { expectedContractId?: string } = {},
): AcceptedProposal {
  const parsed = purchaseProposalSchema.safeParse(input);
  if (!parsed.success) {
    throw new ResearchRequestError(
      `invalid purchase proposal: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const proposal = parsed.data;
  if (options.expectedContractId !== undefined && proposal.contract_id !== options.expectedContractId) {
    throw new ResearchRequestError(
      `proposal is for contract ${proposal.contract_id}, not the selected contract ${options.expectedContractId}`,
    );
  }
  const item = catalog.get(proposal.catalog_item_id);
  if (!item) throw new ResearchRequestError(`catalog item not allowlisted: ${proposal.catalog_item_id}`);
  if (item.affects !== "resolution_risk") {
    throw new ResearchRequestError("proposal is for an outcome forecast, not resolution evidence");
  }
  if (proposal.evidence_type !== item.evidenceType) {
    throw new ResearchRequestError(
      `proposal evidence type ${proposal.evidence_type} does not match catalog item ${item.catalogItemId} (${item.evidenceType})`,
    );
  }

  const parameterNames = Object.keys(proposal.catalog_parameters);
  if (!sameKeys(parameterNames, item.requiredParameters)) {
    throw new ResearchRequestError(
      `catalog parameters must be ${item.requiredParameters.join(", ") || "(none)"}`,
    );
  }
  for (const value of Object.values(proposal.catalog_parameters)) {
    if (value.length === 0 || value.length > 160) throw new ResearchRequestError("catalog parameter value is empty or too long");
  }

  const maxAmount = fromBaseUnits(proposal.max_amount_base_units);
  if (maxAmount > item.maxAmount) throw new ResearchRequestError("proposal ceiling exceeds the catalog price ceiling");
  if (item.price > maxAmount) throw new ResearchRequestError("catalog price exceeds the proposal ceiling");

  const parameters = parseResearchParameters({
    contractId: proposal.contract_id,
    evidenceType: item.evidenceType,
  });

  return {
    selection: { catalogItemId: item.catalogItemId, parameters, maxAmount },
    groupKey: `${proposal.contract_id}:${proposal.evidence_gap_id}`,
    catalogParameters: { ...proposal.catalog_parameters },
    materialUnresolvedGap: true,
  };
}
