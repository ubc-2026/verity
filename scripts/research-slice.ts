/**
 * Records the FIXTURE half of the research vertical slice from the real
 * pipeline: one standard run of the NYC weather market through quote, policy,
 * payment, receipt verification, the QuickNode event and reassessment.
 * Writes samples/research/nyc-weather-slice.json. Needs Python (VERITY_PYTHON).
 *
 *   node scripts/research-slice.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Analyst, findPython } from "../src/app/analyst.ts";
import { RunEngine } from "../src/app/engine.ts";
import { loadFixtureMarkets } from "../src/app/markets.ts";
import { receiptDigest } from "../src/payments/deliveryReceipt.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const analysisDir = join(root, "analysis");
const CONTRACT = "fx-nyc-high-20261118";

const engine = new RunEngine({ analyst: new Analyst(findPython(analysisDir), analysisDir), markets: loadFixtureMarkets(analysisDir) });
try {
  const run = await engine.createRun({ marketId: CONTRACT, scenario: "standard" }, "operator");
  for (const action of ["quote", "decide", "pay", "verify", "webhook", "reassess"]) await engine.step(run.id, action, {});
  const done = engine.get(run.id);
  if (done.delivery?.state !== "verified" || !done.reassessment) throw new Error("the run did not reach a verified reassessment");
  const { signature: _sig, ...unsigned } = done.delivery.receipt;
  const fixture = (JSON.parse(readFileSync(join(analysisDir, "fixtures", "markets_2026-11-17.json"), "utf8")) as { fixture_set: string; markets: any[] });
  const market = fixture.markets.find((m) => m.contract_id === CONTRACT);
  const body = Buffer.from(done.delivery.body).toString("utf8");
  const slice = {
    label: "FIXTURE",
    note: "Recorded from one standard fixture run (scripts/research-slice.ts). The payment, receipt and evidence are FIXTURE; nothing was paid or sent on chain.",
    fixtureSet: fixture.fixture_set,
    contractId: CONTRACT,
    market: {
      question: market.question,
      outcomeLabel: market.outcome_label,
      eventTicker: market.event_ticker,
      expiryUtc: market.expiry_utc,
      settlementSource: market.settlement_source,
      termsUrl: market.terms_url,
      workbookRow: market.workbook_row,
      source: market.source,
      quote: { bestBid: market.market.best_bid, bestAsk: market.market.best_ask, volumeUsd: market.market.volume_usd, volumeBasis: market.market.volume_basis },
      rulesExcerpts: market.rules_excerpts,
    },
    analysis: done.analysis,
    delivery: {
      verifiedAtUtc: done.delivery.verifiedAtUtc,
      outcome: done.delivery.outcome,
      verifiedBy: "verifyDelivery",
      purchaseId: unsigned.purchaseId,
      merchantId: unsigned.merchantId,
      receiptSigner: unsigned.merchant,
      requestHash: unsigned.requestHash,
      contentHashKeccak256: unsigned.contentHash,
      txHash: unsigned.txHash,
      receiptDigest: receiptDigest(unsigned),
      contentSha256: "0x" + createHash("sha256").update(done.delivery.body).digest("hex"),
      bodyUtf8: body,
    },
    reassessment: done.reassessment,
    reassessedAtUtc: done.timeline.find((t) => t.step === "reassess")?.atUtc ?? done.delivery.verifiedAtUtc,
  };
  const out = join(root, "samples", "research", "nyc-weather-slice.json");
  writeFileSync(out, JSON.stringify(slice, null, 2) + "\n");
  console.log(`FIXTURE slice: ${slice.analysis.risk_analysis.rating.final_rating} ${slice.analysis.risk_analysis.rating.raw_total} -> ${slice.reassessment.revised.rating.final_rating} ${slice.reassessment.revised.rating.raw_total} (${slice.reassessment.status}) -> ${out}`);
} finally {
  await engine.close();
}
