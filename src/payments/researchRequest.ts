import canonicalize from "canonicalize";
import { bytesToHex, concat, hexToBytes, isAddress, keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod";
import { parseStrictJson } from "./strictJson.ts";

/**
 * ResearchRequestV1, as pinned in README commit
 * ad091fc15a1d909fa0062a341dc9fc35bad4dd4e ("Hardened x402 payments").
 *
 * requestHash = keccak256(UTF8(JCS(ResearchRequestV1)))
 * nonce       = keccak256(UTF8("verity:eip3009:nonce:v1") || requestHash || salt)
 */
export const RESEARCH_REQUEST_VERSION = "verity-research-request-v1";
export const NONCE_DOMAIN_PREFIX = "verity:eip3009:nonce:v1";

const UINT256_MAX = (1n << 256n) - 1n;

export class ResearchRequestError extends Error {
  override name = "ResearchRequestError";
}

// Provisional identifier and media-type grammars. The pinned README does not
// constrain them; these are deliberately narrow and need teammate sign-off.
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "invalid identifier");
const mediaType = z
  .string()
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, "invalid media type");

const address = z
  .string()
  .refine((value) => isAddress(value, { strict: true }), "invalid address or checksum")
  .transform((value) => value.toLowerCase() as Hex);

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 32-byte hex")
  .transform((value) => value.toLowerCase() as Hex);

const epochSeconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** USDC base units as an exact positive decimal string with no leading zeros. */
const baseUnits = z
  .string()
  .regex(/^[1-9][0-9]*$/, "amount must be a positive decimal string of base units")
  // Zod v4 runs refinements after a failed regex, so guard before BigInt().
  .refine((value) => !/^[1-9][0-9]*$/.test(value) || BigInt(value) <= UINT256_MAX, "amount exceeds uint256");

const resourceUrl = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "resourceUrl is not a URL" });
    return;
  }
  const problems: string[] = [];
  if (url.protocol !== "https:") problems.push("must use https");
  if (url.username || url.password) problems.push("must not carry credentials");
  if (value.includes("?")) problems.push("must not carry a query string");
  if (value.includes("#")) problems.push("must not carry a fragment");
  // Reject rather than silently rewrite: both parties must commit to the same string.
  if (url.href !== value) problems.push(`must be in canonical form (${url.href})`);
  for (const message of problems) ctx.addIssue({ code: "custom", message: `resourceUrl ${message}` });
});

export const researchParametersSchema = z.strictObject({
  contractId: identifier,
  evidenceType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "invalid evidenceType"),
});

export const researchRequestSchema = z
  .strictObject({
    version: z.literal(RESEARCH_REQUEST_VERSION),
    purchaseId: identifier,
    quoteId: identifier,
    merchantId: identifier,
    method: z.literal("POST"),
    resourceUrl,
    parameters: researchParametersSchema,
    contentType: mediaType,
    expectedContentHash: bytes32,
    chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    token: address,
    payer: address,
    payTo: address,
    amount: baseUnits,
    validAfter: epochSeconds,
    validBefore: epochSeconds,
  })
  .refine((request) => request.validBefore > request.validAfter, {
    message: "validBefore must be later than validAfter",
    path: ["validBefore"],
  })
  .brand<"ResearchRequestV1">();

export type ResearchParameters = z.output<typeof researchParametersSchema>;
/** A validated, normalized request. Only `parseResearchRequest` produces one. */
export type ResearchRequestV1 = z.output<typeof researchRequestSchema>;
/** The unvalidated shape callers assemble before crossing the boundary. */
export type ResearchRequestInput = z.input<typeof researchRequestSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** The single validation and normalization boundary for ResearchRequestV1. */
export function parseResearchRequest(input: unknown): ResearchRequestV1 {
  const result = researchRequestSchema.safeParse(input);
  if (!result.success) throw new ResearchRequestError(formatIssues(result.error));
  return result.data;
}

/** Parses raw JSON text, rejecting duplicate keys before schema validation. */
export function parseResearchRequestJson(text: string): ResearchRequestV1 {
  return parseResearchRequest(parseStrictJson(text));
}

export function parseResearchParameters(input: unknown): ResearchParameters {
  const result = researchParametersSchema.safeParse(input);
  if (!result.success) throw new ResearchRequestError(formatIssues(result.error));
  return result.data;
}

export function toBaseUnits(amount: bigint): string {
  if (amount <= 0n || amount > UINT256_MAX) throw new ResearchRequestError("amount out of range");
  return amount.toString(10);
}

export function fromBaseUnits(amount: string): bigint {
  baseUnits.parse(amount);
  return BigInt(amount);
}

/** RFC 8785 canonical JSON of a validated request. */
export function canonicalizeResearchRequest(request: ResearchRequestV1): string {
  const json = canonicalize(request);
  if (json === undefined) throw new ResearchRequestError("request is not serializable");
  return json;
}

export function computeRequestHash(request: ResearchRequestV1): Hex {
  return keccak256(stringToBytes(canonicalizeResearchRequest(request)));
}

function bytes32Of(value: Hex | Uint8Array, label: string): Uint8Array {
  const bytes = typeof value === "string" ? hexToBytes(bytes32.parse(value)) : value;
  if (bytes.length !== 32) throw new ResearchRequestError(`${label} must be exactly 32 bytes`);
  return bytes;
}

/** Fresh 32-byte salt from the platform CSPRNG. Use once per new authorization. */
export function generateSalt(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function deriveNonce(requestHash: Hex, salt: Hex | Uint8Array): Hex {
  return keccak256(
    concat([stringToBytes(NONCE_DOMAIN_PREFIX), bytes32Of(requestHash, "requestHash"), bytes32Of(salt, "salt")]),
  );
}

/** Keccak-256 of raw response bytes. Hash before parsing. */
export function hashContent(body: Uint8Array): Hex {
  return keccak256(body);
}

export interface RequestCommitment {
  requestHash: Hex;
  salt: Hex;
  nonce: Hex;
}

export function commitResearchRequest(request: ResearchRequestV1, salt: Hex): RequestCommitment {
  const requestHash = computeRequestHash(request);
  return { requestHash, salt: bytes32.parse(salt), nonce: deriveNonce(requestHash, salt) };
}
