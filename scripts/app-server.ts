/**
 * Verity app server: the run console (ui/index.html) and the API behind it.
 *   npm run app            -> http://127.0.0.1:8790 (console at /, API under /api)
 *
 * Fixture-first: no key, wallet or network is needed except the optional live
 * read-only market snapshot and live analysis runs (public Gemini Exchange,
 * Gemini terms PDFs and NWS pages only; no model, no payment).
 *
 * Env:
 *   VERITY_OPERATOR_TOKEN  bearer token for operator steps (24+ chars). When
 *                          unset, a random token is generated and printed here,
 *                          on the server console only.
 *   VERITY_OWNER_ADDRESS   enrolled owner wallet for approvals (default: the
 *                          public Anvil test key #3 address, FIXTURE).
 *   VERITY_GATEWAY_RAIL=1  also show the archived live Circle Gateway purchase.
 *   VERITY_PYTHON          Python 3.11+ with pydantic (else analysis/.venv).
 *   PORT                   default 8790. The server binds 127.0.0.1 only.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Hex } from "viem";
import { Analyst, findPython } from "../src/app/analyst.ts";
import { RunEngine } from "../src/app/engine.ts";
import { createAppHandler } from "../src/app/http.ts";
import { LiveMarkets, loadFixtureMarkets } from "../src/app/markets.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const analysisDir = join(root, "analysis");

let operatorToken = process.env.VERITY_OPERATOR_TOKEN ?? "";
if (operatorToken && operatorToken.length < 24) {
  console.error("VERITY_OPERATOR_TOKEN must be at least 24 characters.");
  process.exit(2);
}
const generated = !operatorToken;
if (generated) operatorToken = randomBytes(24).toString("base64url");

const ownerEnv = process.env.VERITY_OWNER_ADDRESS;
if (ownerEnv && !isAddress(ownerEnv)) {
  console.error("VERITY_OWNER_ADDRESS is not an address.");
  process.exit(2);
}

const engine = new RunEngine({
  analyst: new Analyst(findPython(analysisDir), analysisDir),
  markets: loadFixtureMarkets(analysisDir),
  ...(ownerEnv ? { owner: getAddress(ownerEnv) as Hex } : {}),
});
const handler = createAppHandler({
  engine,
  live: new LiveMarkets(),
  operatorToken,
  gatewayEnabled: process.env.VERITY_GATEWAY_RAIL === "1",
  repoRoot: root,
  siteIndex: join(root, "ui", "index.html"),
});

const server = createServer((req, res) => void handler(req, res));
const port = Number(process.env.PORT ?? 8790);
server.listen(port, "127.0.0.1", () => {
  console.log(`Verity run console on http://127.0.0.1:${port}/ (API under /api)`);
  if (generated) console.log(`Operator token for this session (not stored): ${operatorToken}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => void engine.close().then(() => process.exit(0))));
}
