/**
 * npm run e2e:nano -- Circle Gateway nanopayment loop with MOCKED Gateway settlement.
 * Writes samples/e2e-nano.json. No Circle API call, no deposit, no testnet payment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNanoWorkflow } from "./e2e/nanoWorkflow.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const report = await runNanoWorkflow({ analysisDir: join(root, "analysis") });
for (const s of report.scenarios) {
  const failed = Object.entries(s.checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`${failed.length === 0 ? "PASS" : "FAIL"}  ${s.name}`);
  for (const [k, v] of Object.entries(s.statuses)) if (v !== "-") console.log(`      ${k}: ${v}`);
  const changes = (s.details.whatChanged ?? []) as { finding: string; before: string | null; after: string | null; changed: boolean }[];
  for (const c of changes) console.log(`      ${c.changed ? "changed  " : "unchanged"} ${c.finding}: ${c.before} -> ${c.after}`);
  if (failed.length) console.log(`      failed checks: ${failed.join(", ")}`);
}
const out = join(root, "samples", "e2e-nano.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.ok ? "NANO FIXTURE OK" : "NANO FIXTURE FAILED"}  (${report.scenarios.length} scenarios; report: samples/e2e-nano.json)`);
process.exitCode = report.ok ? 0 : 1;
