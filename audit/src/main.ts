import { readFileSync } from "node:fs";
import { ARC_USDC } from "./chain.ts";
import { postOverdueEvent } from "./overdue.ts";
import { reportStream } from "./portalClient.ts";
import { AuditServer } from "./server.ts";
import { openLedger } from "./store.ts";

loadEnvFile(".env");

const missing = ["QUICKNODE_SECURITY_TOKEN", "VERITY_LEDGER_TOKEN", "VERITY_WRITE_TOKEN"].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill the three secrets.`);
  process.exit(1);
}

const ledger = openLedger(process.env.LEDGER_PATH ?? "data/ledger.json", {
  finalityDepth: numberEnv("FINALITY_DEPTH", 1),
  expectedNetwork: process.env.EXPECTED_NETWORK || null,
});

const webhookUrl = process.env.GROK_BOT_WEBHOOK_URL;
const webhookKey = process.env.GROK_BOT_WEBHOOK_KEY;
const sink = webhookUrl && webhookKey ? (event: Parameters<typeof postOverdueEvent>[0]) => postOverdueEvent(event, { url: webhookUrl, key: webhookKey }) : undefined;

const portalUrl = process.env.PORTAL_URL;
const portalToken = process.env.PORTAL_WRITE_TOKEN;
const server = new AuditServer({
  ledger,
  quicknodeSecret: process.env.QUICKNODE_SECURITY_TOKEN!,
  readToken: process.env.VERITY_LEDGER_TOKEN!,
  writeToken: process.env.VERITY_WRITE_TOKEN!,
  maxSkewSeconds: numberEnv("WEBHOOK_MAX_SKEW_SECONDS", 300),
  sink,
  report: portalUrl && portalToken ? (body) => reportStream(portalUrl, portalToken, body, ARC_USDC) : undefined,
});

const port = numberEnv("PORT", 8787);
const host = process.env.HOST ?? "127.0.0.1";
await server.listen(port, host);
console.log(`Verity audit ledger listening on http://${host}:${port}`);
if (!sink) console.log("GROK_BOT_WEBHOOK_URL is unset. Overdue events stay queued until it is set.");
if (!portalUrl || !portalToken) console.log("PORTAL_URL is unset. Chain tickets stay in this ledger until the payment portal is configured.");

const timer = setInterval(() => {
  void server.sweep();
}, numberEnv("SWEEP_MS", 15_000));
timer.unref?.();

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`${name} must be a non-negative integer`);
    process.exit(1);
  }
  return parsed;
}

function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
