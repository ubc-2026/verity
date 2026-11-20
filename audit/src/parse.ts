import { decodeEventLog, isAddress, type Hex } from "viem";
import { AUTHORIZATION_USED_TOPIC, TRANSFER_TOPIC } from "./chain.ts";

const usdcAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AuthorizationUsed",
    inputs: [
      { name: "authorizer", type: "address", indexed: true },
      { name: "nonce", type: "bytes32", indexed: true },
    ],
  },
] as const;

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

export interface TransferLog {
  from: Hex;
  to: Hex;
  value: string;
  logIndex: number;
}

export interface AuthLog {
  authorizer: Hex;
  nonce: Hex;
  logIndex: number;
}

export interface TxEvidence {
  blockNumber: number;
  blockHash: Hex;
  txHash: Hex;
  auths: AuthLog[];
  transfers: TransferLog[];
}

export interface ParsedBlock {
  number: number;
  hash: Hex;
  parentHash: Hex | null;
  txs: TxEvidence[];
}

export interface ReorgNotice {
  number: number;
  hash: Hex | null;
}

export interface ParsedBatch {
  network: string | null;
  reorgs: ReorgNotice[];
  blocks: ParsedBlock[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function hexQuantity(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) return value;
  if (typeof value !== "string") return null;
  if (/^0x[0-9a-fA-F]+$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(parsed);
  }
  if (/^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function bytes32(value: unknown): Hex | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase() as Hex;
}

function address(value: unknown): Hex | null {
  if (typeof value !== "string" || !isAddress(value)) return null;
  return value.toLowerCase() as Hex;
}

function topicsOf(value: unknown): [Hex, ...Hex[]] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const topics: Hex[] = [];
  for (const topic of value) {
    const parsed = bytes32(topic);
    if (!parsed) return null;
    topics.push(parsed);
  }
  return topics as [Hex, ...Hex[]];
}

function successful(status: unknown): boolean {
  if (status === undefined) return true;
  const quantity = hexQuantity(status);
  return quantity === 1;
}

function readReorgs(metadata: Record<string, unknown> | null): ReorgNotice[] {
  if (!metadata) return [];
  const notices: ReorgNotice[] = [];
  const blocks = metadata.blocks_reorged ?? metadata.blocksReorged;
  if (Array.isArray(blocks)) {
    for (const entry of blocks) {
      const number = hexQuantity(entry);
      if (number !== null) notices.push({ number, hash: null });
    }
  }
  const detailed = metadata.reorgs;
  if (Array.isArray(detailed)) {
    for (const entry of detailed) {
      const record = asRecord(entry);
      if (!record) continue;
      const number = hexQuantity(record.blockNumber ?? record.block_number ?? record.number);
      if (number === null) continue;
      const hash = bytes32(record.hash ?? record.blockHash ?? record.block_hash);
      notices.push({ number, hash });
    }
  }
  return notices;
}

interface RawLog {
  address: Hex;
  topics: [Hex, ...Hex[]];
  data: Hex;
  logIndex: number;
}

function readLog(value: unknown, token: Hex): RawLog | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.removed === true) return null;
  const logAddress = address(record.address);
  if (!logAddress || logAddress !== token) return null;
  const topics = topicsOf(record.topics);
  if (!topics) return null;
  if (topics[0] !== TRANSFER_TOPIC && topics[0] !== AUTHORIZATION_USED_TOPIC) return null;
  const data = typeof record.data === "string" && /^0x[0-9a-fA-F]*$/.test(record.data) ? (record.data.toLowerCase() as Hex) : "0x";
  const logIndex = hexQuantity(record.logIndex ?? record.log_index) ?? 0;
  return { address: logAddress, topics, data, logIndex };
}

function decodeLogs(logs: RawLog[]): { auths: AuthLog[]; transfers: TransferLog[] } {
  const auths: AuthLog[] = [];
  const transfers: TransferLog[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({ abi: usdcAbi, data: log.data, topics: log.topics, strict: true });
      if (decoded.eventName === "AuthorizationUsed") {
        const authorizer = address(decoded.args.authorizer);
        const nonce = bytes32(decoded.args.nonce);
        if (authorizer && nonce) auths.push({ authorizer, nonce, logIndex: log.logIndex });
      } else if (decoded.eventName === "Transfer") {
        const from = address(decoded.args.from);
        const to = address(decoded.args.to);
        if (from && to) {
          transfers.push({ from, to, value: decoded.args.value.toString(10), logIndex: log.logIndex });
        }
      }
    } catch {
      continue;
    }
  }
  return { auths, transfers };
}

function readReceipts(value: unknown, token: Hex, blockNumber: number, blockHash: Hex): TxEvidence[] {
  if (!Array.isArray(value)) return [];
  const txs: TxEvidence[] = [];
  for (const entry of value) {
    const receipt = asRecord(entry);
    if (!receipt || !successful(receipt.status)) continue;
    const txHash = bytes32(receipt.transactionHash ?? receipt.transaction_hash);
    if (!txHash) continue;
    const rawLogs = Array.isArray(receipt.logs) ? receipt.logs.flatMap((log) => {
      const parsed = readLog(log, token);
      return parsed ? [parsed] : [];
    }) : [];
    if (rawLogs.length === 0) continue;
    const { auths, transfers } = decodeLogs(rawLogs);
    if (auths.length === 0 && transfers.length === 0) continue;
    txs.push({ blockNumber, blockHash, txHash, auths, transfers });
  }
  return txs;
}

function readBlock(value: unknown, token: Hex): ParsedBlock | null {
  const record = asRecord(value);
  if (!record) return null;
  const block = asRecord(record.block) ?? record;
  const number = hexQuantity(block.number ?? block.blockNumber);
  const hash = bytes32(block.hash ?? block.blockHash);
  if (number === null || !hash) return null;
  const parentHash = bytes32(block.parentHash ?? block.parent_hash);
  const txs = readReceipts(record.receipts, token, number, hash);
  return { number, hash, parentHash, txs };
}

/** Accepts a QuickNode `block_with_receipts` body, including the filtered shape from `streams/arc-usdc-filter.js`. */
export function parseStreamPayload(body: unknown, token: Hex): ParsedBatch {
  const root = asRecord(body);
  if (!root) throw new PayloadError("payload must be an object");
  const metadata = asRecord(root.metadata);
  const network = metadata && typeof metadata.network === "string" ? metadata.network : null;
  const data = root.data;
  if (!Array.isArray(data)) throw new PayloadError("payload data must be an array");

  const blocks: ParsedBlock[] = [];
  for (const entry of data) {
    const block = readBlock(entry, token);
    if (block) blocks.push(block);
  }
  return { network, reorgs: readReorgs(metadata), blocks };
}
