import { isAddress, type Hex } from "viem";
import { z } from "zod";
import { ResearchRequestError, researchParametersSchema } from "./researchRequest.ts";
import { parseStrictJson } from "./strictJson.ts";

/**
 * PROVISIONAL. The pinned README says the 402 quote pins the request, price,
 * recipient, expiry, content type, and content hash, but does not freeze a
 * wire format. This is the minimum the request commitment needs. Coordinate
 * with the merchant workstream before treating it as an interface.
 */
const address = z
  .string()
  .refine((value) => isAddress(value, { strict: true }), "invalid address or checksum")
  .transform((value) => value.toLowerCase() as Hex);

export const verityQuoteSchema = z.strictObject({
  quoteId: z.string().min(1).max(128),
  purchaseId: z.string().min(1).max(128),
  merchantId: z.string().min(1).max(128),
  catalogItemId: z.string().min(1).max(128),
  method: z.literal("POST"),
  resourceUrl: z.string().min(1),
  parameters: researchParametersSchema,
  contentType: z.string().min(1),
  expectedContentHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((value) => value.toLowerCase() as Hex),
  chainId: z.number().int().positive(),
  token: address,
  payTo: address,
  amount: z.string().regex(/^[1-9][0-9]*$/),
  expiresAt: z.number().int().nonnegative(),
  /**
   * Parameters that select which fixture document a catalog item refers to
   * (station and date, for example). They are not part of ResearchRequestV1;
   * the quote's content hash is what the payment commits to.
   */
  catalogParameters: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().min(1).max(160))
    .optional(),
});

export type VerityQuote = z.output<typeof verityQuoteSchema>;

export function parseQuote(input: unknown): VerityQuote {
  const result = verityQuoteSchema.safeParse(typeof input === "string" ? parseStrictJson(input) : input);
  if (!result.success) {
    throw new ResearchRequestError(
      `invalid quote: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}
