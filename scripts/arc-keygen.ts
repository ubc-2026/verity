/**
 * Creates dedicated, low-balance Arc Testnet keys in .env.arc-testnet
 * (gitignored). Prints addresses only. Refuses to overwrite an existing file.
 *   npm run arc:keygen
 */
import { existsSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const file = ".env.arc-testnet";
if (existsSync(file)) {
  console.error(`${file} already exists; not overwriting.`);
  process.exit(1);
}
const payer = generatePrivateKey();
const merchant = generatePrivateKey();
writeFileSync(
  file,
  [
    "# TESTNET ONLY. Dedicated low-balance keys for Arc Testnet. Never reuse on mainnet.",
    `VERITY_PAYER_PRIVATE_KEY=${payer}`,
    `VERITY_MERCHANT_PRIVATE_KEY=${merchant}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`Wrote ${file}. Fund both addresses with Arc Testnet USDC at https://faucet.circle.com/`);
console.log(`payer    ${privateKeyToAccount(payer).address}   needs >= 0.05 USDC (the purchase)`);
console.log(`merchant ${privateKeyToAccount(merchant).address}   needs a little USDC for gas (self-hosted facilitator)`);
