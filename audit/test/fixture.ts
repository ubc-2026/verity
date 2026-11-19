import { encodeAbiParameters, encodeEventTopics, numberToHex, parseAbiItem, type Hex } from "viem";
import { ARC_TESTNET_CHAIN_ID, ARC_USDC } from "../src/chain.ts";
import type { Purchase } from "../src/ledger.ts";

export const PAYER: Hex = "0x1111111111111111111111111111111111111111";
export const PAY_TO: Hex = "0x2222222222222222222222222222222222222222";
export const OTHER: Hex = "0x3333333333333333333333333333333333333333";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const authorizationUsedEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

export function word(value: number): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    purchaseId: "purchase-1",
    requestHash: word(2),
    nonce: word(1),
    payer: PAYER,
    payTo: PAY_TO,
    amountBaseUnits: "50000",
    token: ARC_USDC,
    chainId: ARC_TESTNET_CHAIN_ID,
    merchantLabel: "Verity demo merchant",
    deliveryDeadlineUtc: "2026-11-20T17:00:00Z",
    environment: "arc-testnet",
    ...overrides,
  };
}

export function transferLog(from: Hex, to: Hex, value: bigint, logIndex = 0) {
  return {
    address: ARC_USDC,
    topics: encodeEventTopics({ abi: [transferEvent], eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    logIndex: numberToHex(logIndex),
    removed: false,
  };
}

export function authorizationLog(authorizer: Hex, nonce: Hex, logIndex = 1) {
  return {
    address: ARC_USDC,
    topics: encodeEventTopics({
      abi: [authorizationUsedEvent],
      eventName: "AuthorizationUsed",
      args: { authorizer, nonce },
    }),
    data: "0x",
    logIndex: numberToHex(logIndex),
    removed: false,
  };
}

export function receipt(txHash: Hex, logs: unknown[], status = "0x1") {
  return { transactionHash: txHash, status, logs };
}

export function block(number: number, hash: Hex, parentHash: Hex, receipts: unknown[] = []) {
  return {
    block: { number: numberToHex(number), hash, parentHash },
    receipts,
  };
}

export function payload(blocks: unknown[], metadata: Record<string, unknown> = {}) {
  return { data: blocks, metadata: { network: "arc-testnet", ...metadata } };
}
