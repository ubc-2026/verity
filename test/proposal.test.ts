import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogById } from "../src/payments/catalog.ts";
import { acceptPurchaseProposal } from "../src/payments/proposal.ts";
import { ResearchRequestError } from "../src/payments/researchRequest.ts";
import { NYC_PURCHASE_PROPOSAL } from "./fixtures/nycProposal.ts";

describe("analysis handoff", () => {
  it("accepts the NYC settlement proposal and keeps the station parameters", () => {
    const accepted = acceptPurchaseProposal(NYC_PURCHASE_PROPOSAL, catalogById());
    assert.equal(accepted.selection.catalogItemId, "cat-nws-cli-settlement-version-v1");
    assert.equal(accepted.selection.maxAmount, 50_000n);
    assert.deepEqual(accepted.selection.parameters, {
      contractId: "fx-nyc-high-20261118",
      evidenceType: "settlement_source_version",
    });
    assert.equal(accepted.groupKey, "fx-nyc-high-20261118:GAP-NYC-SETTLE");
    assert.equal(accepted.catalogParameters.station, "Central Park, NY (CLINYC)");
    assert.equal(accepted.materialUnresolvedGap, true);
  });

  it("rejects a proposal whose evidence type or parameters do not match the catalog item", () => {
    const catalog = catalogById();
    assert.throws(() => acceptPurchaseProposal({ ...NYC_PURCHASE_PROPOSAL, evidence_type: "resolution_source" }, catalog), /evidence type/);
    const { evidence_type: _e, ...missing } = NYC_PURCHASE_PROPOSAL;
    assert.throws(() => acceptPurchaseProposal(missing, catalog), ResearchRequestError);
    assert.throws(
      () => acceptPurchaseProposal({ ...NYC_PURCHASE_PROPOSAL, catalog_parameters: { station: "Central Park, NY (CLINYC)", date: "" } }, catalog),
      /empty/,
    );
    assert.throws(
      () => acceptPurchaseProposal({ ...NYC_PURCHASE_PROPOSAL, catalog_parameters: { station: "Central Park, NY (CLINYC)" } }, catalog),
      /catalog parameters must be/,
    );
  });

  it("rejects a signed proposal and an unknown catalog item", () => {
    assert.throws(() => acceptPurchaseProposal({ ...NYC_PURCHASE_PROPOSAL, signed: true }, catalogById()), ResearchRequestError);
    assert.throws(
      () => acceptPurchaseProposal({ ...NYC_PURCHASE_PROPOSAL, catalog_item_id: "not-a-real-item" }, catalogById()),
      ResearchRequestError,
    );
  });
});
