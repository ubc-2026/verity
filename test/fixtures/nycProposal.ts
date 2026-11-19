/** PurchaseProposalV1 copied from analysis-fixture-slice sample nyc_high_gap_remains. */
export const NYC_PURCHASE_PROPOSAL = {
  version: "verity-purchase-proposal-v1",
  proposal_id: "prop-f14ba059791a",
  contract_id: "fx-nyc-high-20261118",
  evidence_gap_id: "GAP-NYC-SETTLE",
  catalog_item_id: "cat-nws-cli-settlement-version-v1",
  evidence_type: "settlement_source_version",
  catalog_parameters: {
    station: "Central Park, NY (CLINYC)",
    date: "2026-11-18",
  },
  rationale:
    "Which issuance of the NWS Central Park daily climate report does the exchange use to settle? No cached or free official source answered it.",
  max_amount_base_units: "50000",
  asset: "USDC",
  network_label: "arc-testnet",
  fixture_label: "FIXTURE: free-check scenario 'free-check-inconclusive' (assumed, not observed)",
  signed: false,
  created_at_utc: "2026-11-18T01:00:00Z",
} as const;
