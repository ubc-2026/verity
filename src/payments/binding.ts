import canonicalize from "canonicalize";
import type { Hex } from "viem";
import { z } from "zod";
import { ResearchRequestError } from "./researchRequest.ts";
import { parseStrictJson } from "./strictJson.ts";

/**
 * `X-Verity-Binding` header: the purchase ID, quote ID, and salt the merchant
 * needs to recompute the nonce.
 *
 * PROVISIONAL encoding: RFC 8785 canonical JSON in the header value. The pinned
 * README names the fields but not the encoding. Coordinate with the merchant.
 */
export const BINDING_HEADER = "X-Verity-Binding";

const bindingSchema = z.strictObject({
  purchaseId: z.string().min(1).max(128),
  quoteId: z.string().min(1).max(128),
  salt: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "salt must be 32-byte hex")
    .transform((value) => value.toLowerCase() as Hex),
});

export type VerityBinding = z.output<typeof bindingSchema>;

export function encodeBindingHeader(binding: VerityBinding): string {
  return canonicalize(bindingSchema.parse(binding)) as string;
}

export function parseBindingHeader(value: string | undefined): VerityBinding {
  if (value === undefined || value.length === 0) throw new ResearchRequestError(`missing ${BINDING_HEADER}`);
  if (value.length > 1024) throw new ResearchRequestError(`${BINDING_HEADER} too long`);
  const result = bindingSchema.safeParse(parseStrictJson(value));
  if (!result.success) throw new ResearchRequestError(`invalid ${BINDING_HEADER}`);
  return result.data;
}
