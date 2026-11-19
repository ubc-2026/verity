/**
 * Read-only Arc Testnet qualification. No keys, no funds, no transactions.
 *   npm run arc:qualify
 *
 * Signs a 0.05 USDC EIP-3009 authorization with a throwaway unfunded key, using
 * a Verity-derived nonce, and simulates transferWithAuthorization via eth_call.
 * A correctly signed authorization should fail only on balance; a wrongly
 * signed one should fail on the signature. The difference shows the token
 * accepts our EIP-712 domain and derived nonce.
 */
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, parseSignature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/payments/arc.ts";
import { USDC_EIP3009_ABI } from "../src/payments/arcFacilitator.ts";
import { deriveNonce, generateSalt } from "../src/payments/researchRequest.ts";

const client = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
const payer = privateKeyToAccount(generatePrivateKey());
const wrong = privateKeyToAccount(generatePrivateKey());
const to: Hex = "0x2222222222222222222222222222222222222222";
const now = Math.floor(Date.now() / 1000);
const message = {
  from: payer.address,
  to,
  value: 50_000n,
  validAfter: BigInt(now - 30),
  validBefore: BigInt(now + 300),
  nonce: deriveNonce(`0x${"ab".repeat(32)}`, generateSalt()),
};

async function simulate(signedBy: typeof payer): Promise<string> {
  const signature = await signedBy.signTypedData({
    domain: { ...ARC_TESTNET.usdcDomain, chainId: ARC_TESTNET.chainId, verifyingContract: ARC_TESTNET.usdc },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });
  const { r, s, v, yParity } = parseSignature(signature);
  try {
    await client.simulateContract({
      account: to,
      address: ARC_TESTNET.usdc,
      abi: USDC_EIP3009_ABI,
      functionName: "transferWithAuthorization",
      args: [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, Number(v ?? BigInt(27 + yParity)), r, s],
    });
    return "SUCCEEDED (unexpected for an unfunded payer)";
  } catch (error) {
    const revert = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    return revert instanceof ContractFunctionRevertedError
      ? `reverted: ${revert.reason ?? revert.shortMessage}`
      : `error: ${(error as Error).message.split("\n")[0]}`;
  }
}

console.log(`chainId ${await client.getChainId()}  token ${ARC_TESTNET.usdc}  nonce ${message.nonce}`);
const correct = await simulate(payer);
const forged = await simulate(wrong);
console.log(`correctly signed: ${correct}`);
console.log(`wrong signer:     ${forged}`);
const ok = /balance/i.test(correct) && /signature/i.test(forged);
console.log(ok ? "QUALIFIED: token accepts the Verity domain and derived nonce; only funding is missing" : "NOT QUALIFIED: inspect the revert reasons above");
process.exitCode = ok ? 0 : 1;
