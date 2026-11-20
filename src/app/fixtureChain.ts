/**
 * FIXTURE chain for the app server: a stubbed settlement adapter and a locally
 * signed QuickNode delivery. No transaction is sent and no key is real. The tx
 * hash is derived from the authorization nonce, so it is not on Arc Testnet.
 */
import { createHash } from "node:crypto";
import { keccak256, pad, toBytes, toHex, type Hex } from "viem";
import { ARC_TESTNET } from "../payments/arc.ts";
import { ARC_TESTNET_GATEWAY_WALLET } from "../payments/circleGateway.ts";
import type { DeliverySettlementAdapter } from "../payments/merchantDelivery.ts";
import { AUTHORIZATION_USED_TOPIC, TRANSFER_TOPIC } from "../reconciliation/ledger.ts";
import { signQuickNodePayload } from "../reconciliation/quicknodeSignature.ts";
import { runStreamFilter } from "../reconciliation/runFilter.ts";

export interface StubSettled {
  txHash: Hex;
  payer: Hex;
  payTo: Hex;
  amount: bigint;
  nonce: Hex;
}

/** Fixture block height for every stubbed settlement, below the fixture finalized height. */
export const FIXTURE_BLOCK = 72781628;
export const FIXTURE_FINALIZED_BLOCK = 72781700n;

export class StubSettlement implements DeliverySettlementAdapter {
  settleCalls = 0;
  resumeCalls = 0;
  readonly settled: StubSettled[] = [];

  static txFor(nonce: Hex): Hex {
    return keccak256(toBytes(`verity-fixture-tx|${nonce}`));
  }

  async settle(verified: Parameters<DeliverySettlementAdapter["settle"]>[0]) {
    this.settleCalls += 1;
    const txHash = StubSettlement.txFor(verified.nonce);
    this.settled.push({ txHash, payer: verified.request.payer, payTo: verified.request.payTo, amount: BigInt(verified.request.amount), nonce: verified.nonce });
    return { txHash };
  }

  async resume(verified: Parameters<DeliverySettlementAdapter["settle"]>[0], _auth: unknown, txHash: Hex) {
    this.resumeCalls += 1;
    this.settled.push({ txHash, payer: verified.request.payer, payTo: verified.request.payTo, amount: BigInt(verified.request.amount), nonce: verified.nonce });
    return { txHash };
  }
}

function blockEntry(s: StubSettled, blockTimestamp: number, txFrom: Hex) {
  const topic = (a: Hex) => pad(a.toLowerCase() as Hex, { size: 32 });
  return {
    block: { number: toHex(FIXTURE_BLOCK), hash: keccak256(toBytes(`block|${s.txHash}`)), timestamp: toHex(blockTimestamp) },
    receipts: [
      {
        transactionHash: s.txHash,
        transactionIndex: "0x0",
        from: txFrom,
        to: ARC_TESTNET.usdc,
        status: "0x1",
        logs: [
          { address: ARC_TESTNET.usdc, topics: [AUTHORIZATION_USED_TOPIC, topic(s.payer), s.nonce], data: "0x", logIndex: "0x1" },
          { address: ARC_TESTNET.usdc, topics: [TRANSFER_TOPIC, topic(s.payer), topic(s.payTo)], data: toHex(s.amount, { size: 32 }), logIndex: "0x2" },
        ],
      },
    ],
  };
}

export interface SignedDelivery {
  payload: string;
  headers: Record<string, string>;
}

/**
 * The QuickNode Streams delivery the fixture chain would produce for one
 * settlement: the real stream filter's output, HMAC-signed with a fixture token.
 */
export function signedFixtureDelivery(args: {
  settled: StubSettled;
  blockTimestamp: number;
  txFrom: Hex;
  securityToken: string;
  timestamp: number;
  streamId: string;
}): SignedDelivery {
  const payload = JSON.stringify(
    runStreamFilter({ data: [blockEntry(args.settled, args.blockTimestamp, args.txFrom)], metadata: { stream_id: args.streamId } }, [args.settled.txHash]),
  );
  const nonce = createHash("sha256").update(`${args.streamId}|${args.settled.txHash}|${args.timestamp}`).digest("hex").slice(0, 16);
  const timestamp = String(args.timestamp);
  return {
    payload,
    headers: {
      "x-qn-nonce": nonce,
      "x-qn-timestamp": timestamp,
      "x-qn-signature": signQuickNodePayload(args.securityToken, nonce, timestamp, payload),
      "stream-id": args.streamId,
    },
  };
}

/** FIXTURE Gateway batch block, also below the fixture finalized height. */
export const FIXTURE_GATEWAY_BLOCK = 72781650;

/**
 * The QuickNode delivery for one Gateway batch transaction: a successful receipt sent to the
 * GatewayWallet with a single GatewayWallet log that names neither payer nor seller (as observed
 * for the archived live batch), passed through the real stream filter and HMAC-signed with a
 * fixture token. It confirms the batch transaction only.
 */
export function signedGatewayBatchDelivery(args: {
  batchTxHash: Hex;
  blockNumber?: number;
  blockTimestamp: number;
  securityToken: string;
  timestamp: number;
  streamId: string;
}): SignedDelivery {
  const blockNumber = args.blockNumber ?? FIXTURE_GATEWAY_BLOCK;
  const entry = {
    block: { number: toHex(blockNumber), hash: keccak256(toBytes(`block|${args.batchTxHash}`)), timestamp: toHex(args.blockTimestamp) },
    receipts: [
      {
        transactionHash: args.batchTxHash,
        transactionIndex: "0x0",
        from: "0x000000000000000000000000000000000000c1c1",
        to: ARC_TESTNET_GATEWAY_WALLET,
        status: "0x1",
        logs: [{ address: ARC_TESTNET_GATEWAY_WALLET, topics: [keccak256(toBytes("fixture-gateway-batch-event"))], data: "0x", logIndex: "0x0" }],
      },
    ],
  };
  const payload = JSON.stringify(runStreamFilter({ data: [entry], metadata: { stream_id: args.streamId } }, [args.batchTxHash]));
  const nonce = createHash("sha256").update(`${args.streamId}|${args.batchTxHash}|${args.timestamp}`).digest("hex").slice(0, 16);
  const timestamp = String(args.timestamp);
  return {
    payload,
    headers: {
      "x-qn-nonce": nonce,
      "x-qn-timestamp": timestamp,
      "x-qn-signature": signQuickNodePayload(args.securityToken, nonce, timestamp, payload),
      "stream-id": args.streamId,
    },
  };
}
