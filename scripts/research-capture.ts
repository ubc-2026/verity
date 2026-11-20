/**
 * Captures one Gemini Exchange event (public API, one GET, no key) into
 * samples/research/captures/<ticker>-<time>.json, labeled CAPTURED.
 *
 *   node scripts/research-capture.ts WXHIGH-NYC-2611190459
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureEvent } from "../src/research/capture.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ticker = process.argv[2] ?? "";
const capture = await captureEvent(ticker);
const dir = join(root, "samples", "research", "captures");
mkdirSync(dir, { recursive: true });
const out = join(dir, `${ticker}-${capture.fetchedAtUtc.replace(/[:.]/g, "")}.json`);
writeFileSync(out, JSON.stringify(capture, null, 2) + "\n");
console.log(`${capture.unavailableReason ? "UNAVAILABLE " + capture.unavailableReason : "CAPTURED"} ${capture.fetchedAtUtc} -> ${out}`);
