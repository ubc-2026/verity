import { createHash } from "node:crypto";
import { keccak256, recoverTypedDataAddress, toBytes, type Hex } from "viem";
import {
  gatewayAuthorizationDomain,
  type GatewayPaymentPayload,
  type GatewayProvider,
  type GatewayRequirements,
  type GatewayTransfer,
} from "../../src/payments/circleGateway.ts";

/** Circle SDK constant GATEWAY_MIN_AUTH_VALIDITY_SECONDS. */
const MIN_VALIDITY_SECONDS = 7 * 24 * 60 * 60;

const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * FIXTURE Circle Gateway. No network and no funds. It mirrors the checks the
 * real facilitator is documented to make and that a test can observe: the
 * signature under the GatewayWalletBatched domain, requirements matching the
 * authorization, the 7-day minimum validity, a Gateway balance, and nonce reuse
 * (`nonce_already_used`). Accepted payments become per-payment transfers that a
 * test advances through received -> batched -> completed. Batch tx hashes are
 * derived, not real.
 */
export class MockGatewayProvider implements GatewayProvider {
  readonly mode = "fixture" as const;
  verifyCalls = 0;
  settleCalls = 0;
  readonly #balances = new Map<string, bigint>();
  readonly #transfers = new Map<string, GatewayTransfer>();
  readonly #byNonce = new Map<string, string>();
  readonly #now: () => number;

  constructor(options: { now: () => number; balances: Record<string, bigint> }) {
    this.#now = options.now;
    for (const [address, amount] of Object.entries(options.balances)) this.#balances.set(address.toLowerCase(), amount);
  }

  async #check(payload: GatewayPaymentPayload, requirements: GatewayRequirements): Promise<string | null> {
    const auth = payload.payload.authorization;
    if (requirements.extra.name !== "GatewayWalletBatched") return "unsupported_scheme";
    if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) return "recipient_mismatch";
    if (auth.value !== requirements.amount) return "amount_mismatch";
    const now = this.#now();
    if (Number(auth.validAfter) > now || Number(auth.validBefore) <= now) return "authorization_expired";
    if (Number(auth.validBefore) - now < MIN_VALIDITY_SECONDS) return "authorization_validity_too_short";
    const signer = await recoverTypedDataAddress({
      domain: { ...gatewayAuthorizationDomain(requirements.extra.verifyingContract as Hex), chainId: Number(requirements.network.split(":")[1]) },
      types,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as Hex,
        to: auth.to as Hex,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as Hex,
      },
      signature: payload.payload.signature as Hex,
    }).catch(() => undefined);
    if (!signer || signer.toLowerCase() !== auth.from.toLowerCase()) return "invalid_signature";
    if (this.#byNonce.has(auth.nonce.toLowerCase())) return "nonce_already_used";
    if ((this.#balances.get(auth.from.toLowerCase()) ?? 0n) < BigInt(auth.value)) return "insufficient_balance";
    return null;
  }

  async verify(payload: GatewayPaymentPayload, requirements: GatewayRequirements) {
    this.verifyCalls += 1;
    const problem = await this.#check(payload, requirements);
    return problem ? { isValid: false, invalidReason: problem } : { isValid: true, payer: payload.payload.authorization.from };
  }

  async settle(payload: GatewayPaymentPayload, requirements: GatewayRequirements) {
    this.settleCalls += 1;
    const problem = await this.#check(payload, requirements);
    const auth = payload.payload.authorization;
    if (problem) return { success: false, errorReason: problem, transaction: "" };
    this.#balances.set(auth.from.toLowerCase(), (this.#balances.get(auth.from.toLowerCase()) ?? 0n) - BigInt(auth.value));
    const digest = createHash("sha256").update(`gateway-transfer|${auth.nonce.toLowerCase()}`).digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    this.#transfers.set(id, {
      id,
      status: "received",
      amount: auth.value,
      fromAddress: auth.from.toLowerCase(),
      toAddress: auth.to.toLowerCase(),
      nonce: auth.nonce.toLowerCase(),
      txHash: null,
    });
    this.#byNonce.set(auth.nonce.toLowerCase(), id);
    return { success: true, payer: auth.from, transaction: id };
  }

  async transferByNonce(nonce: Hex) {
    const id = this.#byNonce.get(nonce.toLowerCase());
    return id ? { ...this.#transfers.get(id)! } : undefined;
  }

  async transferById(id: string) {
    const transfer = this.#transfers.get(id);
    if (!transfer) throw new Error(`no transfer ${id}`);
    return { ...transfer };
  }

  /** Moves every open transfer one step: received -> batched (batch tx assigned) -> completed. */
  advanceBatch(): void {
    const batchTx = keccak256(toBytes(`verity-fixture-gateway-batch|${this.#now()}`));
    for (const transfer of this.#transfers.values()) {
      if (transfer.status === "received") Object.assign(transfer, { status: "batched", txHash: batchTx });
      else if (transfer.status === "batched") transfer.status = "completed";
    }
  }
}
