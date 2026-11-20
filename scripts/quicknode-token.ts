/**
 * Generates the QuickNode Streams webhook security token locally and stores it
 * in .env.quicknode (gitignored). Never prints the token.
 *   npm run quicknode:token
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const file = ".env.quicknode";
const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
if (/^VERITY_QN_SECURITY_TOKEN=/m.test(existing)) {
  console.log(`${file} already has VERITY_QN_SECURITY_TOKEN; not replacing it.`);
  process.exit(0);
}
const line = `VERITY_QN_SECURITY_TOKEN=${randomBytes(32).toString("hex")}\n`;
if (existing) appendFileSync(file, (existing.endsWith("\n") ? "" : "\n") + line);
else writeFileSync(file, `# QuickNode Streams settings. TESTNET ONLY. Gitignored.\n${line}`, { mode: 0o600 });
console.log(`Wrote VERITY_QN_SECURITY_TOKEN (64 hex chars) to ${file}.`);
