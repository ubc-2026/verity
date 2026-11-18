import type { Hex } from "viem";

/**
 * Arc Testnet USDC, confirmed against the live contract on 2026-11-17:
 * name() = "USDC", version() = "2", decimals() = 6, and DOMAIN_SEPARATOR()
 * equals the separator computed from this domain. The x402 SDK default asset
 * for eip155:5042002 uses the same name and version.
 */
export const ARC_TESTNET = {
  chainId: 5042002,
  caip2: "eip155:5042002",
  usdc: "0x3600000000000000000000000000000000000000" as Hex,
  usdcDomain: { name: "USDC", version: "2" },
  usdcDecimals: 6,
  domainSeparator: "0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0" as Hex,
  explorer: "https://explorer.testnet.arc.io",
} as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
