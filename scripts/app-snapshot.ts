/**
 * Writes the read-only fixture preview the website shows when no app server is
 * running (a static deploy, for example). It drives the same engine the
 * server uses through the happy path and two other outcomes, then saves the
 * public views only: no operator data, no credentials.
 *   npm run app:snapshot   -> site/src/fixture-preview.json
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Analyst, findPython } from "../src/app/analyst.ts";
import { RunEngine, SCENARIOS } from "../src/app/engine.ts";
import { capabilities } from "../src/app/http.ts";
import { loadFixtureMarkets } from "../src/app/markets.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const analysisDir = join(root, "analysis");
const engine = new RunEngine({ analyst: new Analyst(findPython(analysisDir), analysisDir), markets: loadFixtureMarkets(analysisDir) });

async function drive(marketId: string, scenario: keyof typeof SCENARIOS, actions: string[]) {
  const run = await engine.createRun({ marketId, scenario }, "operator");
  for (const action of actions) await engine.step(run.id, action, {});
  return engine.publicView(run);
}

const runs = [
  await drive("fx-nyc-high-20261118", "standard", ["quote", "decide", "pay", "verify", "webhook", "webhook-replay", "retry", "reassess"]),
  await drive("fx-okc-moneyline-20261118", "standard", []),
  await drive("fx-nyc-high-20261118", "tampered", ["quote", "decide", "pay", "verify", "webhook"]),
];
const preview = {
  label: "FIXTURE preview",
  note: "Recorded from the fixture engine (npm run app:snapshot). Read-only: start npm run app for live steps.",
  scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label, detail: s.detail })),
  capabilities: capabilities({ gatewayEnabled: false, engine }),
  markets: engine.markets(),
  runs,
};
writeFileSync(join(root, "site", "src", "fixture-preview.json"), `${JSON.stringify(preview, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
await engine.close();
console.log(`wrote site/src/fixture-preview.json (${runs.length} runs)`);
