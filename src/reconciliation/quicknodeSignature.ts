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

/**
 * Optional replay window. When set, X-QN-Timestamp must be Unix seconds (or
 * milliseconds) within `maxSkewSeconds` of `now`. Live ingestion sets it; an
 * old signed delivery replayed later is then refused before it is parsed.
 */
export interface SignatureWindow {
  now: number;
  maxSkewSeconds: number;
}

export function timestampWithinWindow(timestamp: string, window: SignatureWindow): boolean {
  if (!/^[0-9]{9,13}$/.test(timestamp)) return false;
  const value = Number(timestamp);
  const seconds = timestamp.length >= 13 ? Math.floor(value / 1000) : value;
  return Math.abs(window.now - seconds) <= window.maxSkewSeconds;
}

export function verifyQuickNodeSignature(securityToken: string, request: QuickNodeSignedRequest, window?: SignatureWindow): boolean {
  const { nonce, timestamp, signature, payload } = request;
  if (!securityToken || !nonce || !timestamp || !signature) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  if (window && !timestampWithinWindow(timestamp, window)) return false;
  const expected = Buffer.from(signQuickNodePayload(securityToken, nonce, timestamp, payload), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
