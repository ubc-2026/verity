import { keccak256, toBytes, type Hex } from "viem";

/** Circle Arc Testnet. USDC uses 6 decimals; 0.05 USDC is "50000". */
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_USDC: Hex = "0x3600000000000000000000000000000000000000";
export const ARC_EXPLORER_TX_BASE = "https://explorer.testnet.arc.io/tx/";

export const TRANSFER_TOPIC: Hex = keccak256(toBytes("Transfer(address,address,uint256)"));
export const AUTHORIZATION_USED_TOPIC: Hex = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));

export const LEDGER_STATUSES = [
  "Reconciled",
  "Paid, delivery missing",
  "Delivered, payment unconfirmed",
  "Mismatch",
  "Duplicate payment",
  "Payment pending",
  "Unmatched payment",
] as const;

export type LedgerStatus = (typeof LEDGER_STATUSES)[number];
