import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findPython, runWorkflow } from "../scripts/e2e/workflow.ts";

const analysisDir = join(dirname(fileURLToPath(import.meta.url)), "..", "analysis");
let python: string | undefined;
let skip: string | false = false;
try {
  python = findPython(analysisDir);
} catch (error) {
  skip = `connected workflow needs Python: ${(error as Error).message}`;
}

describe("connected fixture workflow", () => {
  it("runs every scenario and passes every check", { skip, timeout: 120_000 }, async () => {
    const report = await runWorkflow({ analysisDir, python });
    assert.deepEqual(report.failedChecks, []);
    const names = report.scenarios.map((s) => s.name);
    assert.deepEqual(names, [
      "positive_purchase_changes_assessment",
      "no_material_gap",
      "evidence_available_free",
      "budget_denial",
      "tampered_delivery",
      "retry_without_second_settlement",
      "overdue_delivery_alert",
    ]);
    const positive = report.scenarios[0]!;
    assert.equal(positive.statuses.ledger, "Reconciled");
    assert.equal(positive.reassessment?.status, "revised");
  });
});
