import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PortalServer } from "./server.ts";
import { PortalStore } from "./store.ts";

loadEnvFile(".env");

const missing = ["PORTAL_READ_TOKEN", "PORTAL_WRITE_TOKEN"].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill the two secrets.`);
  process.exit(1);
}

const databasePath = process.env.DATABASE_PATH ?? "data/portal.sqlite";
mkdirSync(dirname(databasePath), { recursive: true });
const store = new PortalStore(databasePath, numberEnv("FINALITY_DEPTH", 1));
const server = new PortalServer({
  store,
  readToken: process.env.PORTAL_READ_TOKEN!,
  writeToken: process.env.PORTAL_WRITE_TOKEN!,
  allowedOrigins: (process.env.PORTAL_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
});

const port = numberEnv("PORT", 8788);
const host = process.env.HOST ?? "127.0.0.1";
await server.listen(port, host);
console.log(`Verity payment portal listening on http://${host}:${port}`);

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
