import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * QuickNode Streams webhook authentication.
 *
 * Per QuickNode's "Validating incoming Streams webhook messages" guide:
 *   signature = hex(HMAC-SHA256(securityToken, nonce + timestamp + payload))
 * with headers X-QN-Nonce, X-QN-Timestamp, X-QN-Signature. The payload is the
 * decoded (un-gzipped) body text.
 */
export interface QuickNodeSignedRequest {
  nonce: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  payload: string;
}

export function signQuickNodePayload(securityToken: string, nonce: string, timestamp: string, payload: string): string {
  return createHmac("sha256", Buffer.from(securityToken)).update(nonce + timestamp + payload).digest("hex");
}

export function verifyQuickNodeSignature(securityToken: string, request: QuickNodeSignedRequest): boolean {
  const { nonce, timestamp, signature, payload } = request;
  if (!securityToken || !nonce || !timestamp || !signature) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signQuickNodePayload(securityToken, nonce, timestamp, payload), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
