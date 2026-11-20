/**
 * npm run e2e -- runs the connected fixture workflow and writes samples/e2e-workflow.json.
 * Fixture only: no chain, no QuickNode, no Grok Bot, no ElevenLabs, no Exa call.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflow } from "./e2e/workflow.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "samples", "e2e-workflow.json");
const report = await runWorkflow({ analysisDir: join(root, "analysis") });

for (const s of report.scenarios) {
  const failed = Object.entries(s.checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`${failed.length === 0 ? "PASS" : "FAIL"}  ${s.name}`);
  console.log(`      analysis=${s.statuses.analysis}  payment=${s.statuses.payment}  delivery=${s.statuses.delivery}  ledger=${s.statuses.ledger ?? "-"}`);
  if (s.reassessment) {
    for (const c of s.reassessment.changes) console.log(`      ${c.changed ? "changed  " : "unchanged"} ${c.finding}: ${c.before} -> ${c.after} (${c.reason})`);
  }
  if (s.analysis.noPurchaseReason) console.log(`      no purchase: ${s.analysis.noPurchaseReason}`);
  if (failed.length) console.log(`      failed checks: ${failed.join(", ")}`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.ok ? "E2E FIXTURE OK" : "E2E FIXTURE FAILED"}  (${report.scenarios.length} scenarios; report: samples/e2e-workflow.json)`);
process.exitCode = report.ok ? 0 : 1;
