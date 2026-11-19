import {
  parseAbi,
  parseEventLogs,
  parseSignature,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { ARC_TESTNET } from "./arc.ts";
import type { Eip3009Authorization, SettlementAdapter, VerifyResult } from "./merchant.ts";

/**
 * Testnet-only self-hosted x402 facilitator for Arc Testnet USDC.
 *
 * The hosted x402.org facilitator does not list eip155:5042002 (checked
 * 2026-11-17: its only EVM network is Base Sepolia), so this follows the pinned
 * README fallback: verify against the pinned USDC token and broadcast the exact
 * signed EIP-3009 transfer. The relayer key pays gas and never holds payer funds.
 */
export const USDC_EIP3009_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export class SettlementError extends Error {
  override name = "SettlementError";
  readonly txHash: Hex | undefined;
  /** True only when the transfer was submitted and its outcome is still unknown. */
  readonly pending: boolean;
  constructor(message: string, txHash?: Hex, pending = false) {
    super(message);
    this.txHash = txHash;
    this.pending = pending;
  }
}

export interface SettlementReceipt {
  txHash: Hex;
  blockNumber: bigint;
  status: "success" | "reverted";
  gasUsed: bigint;
  authorizationUsedLog: boolean;
  transferLog: boolean;
}

/** The chain operations the facilitator needs; viem-backed in production, faked in tests. */
export interface ArcChain {
  chainId(): Promise<number>;
  authorizationUsed(authorizer: Hex, nonce: Hex): Promise<boolean>;
  submitTransferWithAuthorization(authorization: Eip3009Authorization): Promise<Hex>;
  waitForReceipt(txHash: Hex, authorization: Eip3009Authorization): Promise<SettlementReceipt>;
}

export function summarizeReceipt(receipt: TransactionReceipt, authorization: Eip3009Authorization): SettlementReceipt {
  const token = ARC_TESTNET.usdc.toLowerCase();
  const logs = parseEventLogs({
    abi: USDC_EIP3009_ABI,
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === token),
  });
  const from = authorization.from.toLowerCase();
  return {
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    authorizationUsedLog: logs.some(
      (log) =>
        log.eventName === "AuthorizationUsed" &&
        log.args.authorizer.toLowerCase() === from &&
        log.args.nonce.toLowerCase() === authorization.nonce.toLowerCase(),
    ),
    transferLog: logs.some(
      (log) =>
        log.eventName === "Transfer" &&
        log.args.from.toLowerCase() === from &&
        log.args.to.toLowerCase() === authorization.to.toLowerCase() &&
        log.args.value === BigInt(authorization.value),
    ),
  };
}

export function viemArcChain(publicClient: PublicClient, walletClient: WalletClient): ArcChain {
  const address = ARC_TESTNET.usdc;
  return {
    chainId: () => publicClient.getChainId(),
    authorizationUsed: (authorizer, nonce) =>
      publicClient.readContract({ address, abi: USDC_EIP3009_ABI, functionName: "authorizationState", args: [authorizer, nonce] }),
    async submitTransferWithAuthorization(auth) {
      const { r, s, v, yParity } = parseSignature(auth.signature);
      const { request } = await publicClient.simulateContract({
        account: walletClient.account!,
        address,
        abi: USDC_EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args: [
          auth.from,
          auth.to,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce,
          Number(v ?? BigInt(27 + yParity)),
          r,
          s,
        ],
      });
      return walletClient.writeContract(request);
    },
    async waitForReceipt(txHash, auth) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      return summarizeReceipt(receipt, auth);
    },
  };
}

export class SelfHostedArcFacilitator implements SettlementAdapter {
  readonly chain: ArcChain;
  readonly onSubmitted: (txHash: Hex) => void;
  constructor(chain: ArcChain, onSubmitted: (txHash: Hex) => void = () => {}) {
    this.chain = chain;
    this.onSubmitted = onSubmitted;
  }

  async settle(verified: Extract<VerifyResult, { ok: true }>, auth: Eip3009Authorization): Promise<SettlementReceipt> {
    const { request } = verified;
    if (request.chainId !== ARC_TESTNET.chainId || request.token !== ARC_TESTNET.usdc.toLowerCase()) {
      throw new SettlementError("facilitator only settles pinned Arc Testnet USDC");
    }
    if ((await this.chain.chainId()) !== ARC_TESTNET.chainId) throw new SettlementError("RPC is not Arc Testnet");
    if (auth.nonce.toLowerCase() !== verified.nonce) throw new SettlementError("authorization nonce differs from verified nonce");
    if (await this.chain.authorizationUsed(auth.from, auth.nonce)) {
      throw new SettlementError("authorization nonce already used on chain; no second transfer submitted");
    }

    const txHash = await this.chain.submitTransferWithAuthorization(auth);
    this.onSubmitted(txHash);
    return this.#confirm(auth, txHash);
  }

  /**
   * Retry path for a transfer already submitted (e.g. after a timeout):
   * waits on the known tx hash and applies the same receipt checks. It never
   * submits again.
   */
  async resume(verified: Extract<VerifyResult, { ok: true }>, auth: Eip3009Authorization, txHash: Hex): Promise<SettlementReceipt> {
    if (auth.nonce.toLowerCase() !== verified.nonce) throw new SettlementError("authorization nonce differs from verified nonce", txHash);
    return this.#confirm(auth, txHash);
  }

  async #confirm(auth: Eip3009Authorization, txHash: Hex): Promise<SettlementReceipt> {
    let receipt: SettlementReceipt;
    try {
      receipt = await this.chain.waitForReceipt(txHash, auth);
    } catch (error) {
      throw new SettlementError(`submitted but outcome unknown: ${(error as Error).message}`, txHash, true);
    }
    if (receipt.status !== "success") throw new SettlementError("transfer reverted", txHash);
    if (!receipt.authorizationUsedLog || !receipt.transferLog) {
      throw new SettlementError("receipt logs do not match the authorization", txHash);
    }
    return receipt;
  }
}
