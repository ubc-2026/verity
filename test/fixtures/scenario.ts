/**
 * DEMO FIXTURE: a local buyer/merchant scenario for tests and `npm run fixture`.
 * The private key is the public Anvil/Hardhat test key #0. Never fund it.
 * The token EIP-712 domain is the Arc Testnet USDC domain confirmed on chain
 * (see src/payments/arc.ts).
 */
import { ARC_TESTNET } from "../../src/payments/arc.ts";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { catalogById, RESOLUTION_ITEM } from "../../src/payments/catalog.ts";
import type { MerchantConfig, SavedQuote } from "../../src/payments/merchant.ts";
import type { ResearchRequestV1 } from "../../src/payments/researchRequest.ts";

export const DEMO_PAYER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
export const DEMO_OTHER_SIGNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
/** Anvil test key #2. Signs delivery receipts. Never fund it. */
export const DEMO_MERCHANT_SIGNER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
/** Anvil test key #3. Enrolled owner. Never fund it. */
export const DEMO_OWNER = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);

export const DEMO_NOW = 1795185100;
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_USDC: Hex = "0x3600000000000000000000000000000000000000";
export const DEMO_PAY_TO: Hex = "0x2222222222222222222222222222222222222222";
export const DEMO_CONTENT_HASH: Hex = "0xecb8d0303298a3bff971405264cc3670f3297da1468bd6c39a3e32e5abd2dda9";

export const DEMO_CATALOG_ITEM = RESOLUTION_ITEM;
export const DEMO_CATALOG = catalogById();

export const DEMO_PARAMETERS = { contractId: "demo-contract-001", evidenceType: "resolution_source" };

export function demoQuote(): SavedQuote {
  return {
    quoteId: "quote-demo-001",
    purchaseId: "purchase-demo-001",
    merchantId: "verity-demo-merchant",
    catalogItemId: DEMO_CATALOG_ITEM.catalogItemId,
    method: "POST",
    resourceUrl: DEMO_CATALOG_ITEM.resourceUrl,
    parameters: { ...DEMO_PARAMETERS },
    contentType: "application/json",
    expectedContentHash: DEMO_CONTENT_HASH,
    chainId: ARC_TESTNET_CHAIN_ID,
    token: ARC_TESTNET_USDC,
    payTo: DEMO_PAY_TO,
    amount: "50000",
    expiresAt: DEMO_NOW + 600,
    buyerSessionId: "session-demo-001",
  };
}

export const DEMO_MERCHANT_CONFIG: MerchantConfig = {
  origin: "https://merchant.example",
  merchantId: "verity-demo-merchant",
  chainId: ARC_TESTNET_CHAIN_ID,
  token: ARC_TESTNET_USDC,
  payTo: DEMO_PAY_TO,
  tokenDomain: ARC_TESTNET.usdcDomain,
  maxAuthorizationWindowSeconds: 600,
};

export async function signTransferWithAuthorization(
  request: ResearchRequestV1,
  nonce: Hex,
  signer = DEMO_PAYER,
): Promise<Hex> {
  return signer.signTypedData({
    domain: {
      ...DEMO_MERCHANT_CONFIG.tokenDomain,
      chainId: request.chainId,
      verifyingContract: request.token,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: request.payer,
      to: request.payTo,
      value: BigInt(request.amount),
      validAfter: BigInt(request.validAfter),
      validBefore: BigInt(request.validBefore),
      nonce,
    },
  });
}
