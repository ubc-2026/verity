import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * QuickNode Streams signs the uncompressed JSON body as
 * HMAC-SHA256(securityToken, nonce + timestamp + payload), hex-encoded.
 * https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages
 */
export function signWebhook(secret: string, nonce: string, timestamp: string, payload: string): string {
  return createHmac("sha256", Buffer.from(secret)).update(Buffer.from(nonce + timestamp + payload)).digest("hex");
}

export function verifyWebhook(input: {
  secret: string;
  nonce: string;
  timestamp: string;
  payload: string;
  signature: string;
  nowSeconds: number;
  maxSkewSeconds: number;
}): boolean {
  if (!input.secret || !input.nonce || !input.timestamp || !input.signature) return false;
  if (!/^[0-9a-fA-F]+$/.test(input.signature) || input.signature.length % 2 !== 0) return false;
  const stamped = Number(input.timestamp);
  if (!Number.isFinite(stamped)) return false;
  if (Math.abs(input.nowSeconds - stamped) > input.maxSkewSeconds) return false;

  const computed = signWebhook(input.secret, input.nonce, input.timestamp, input.payload);
  const given = Buffer.from(input.signature, "hex");
  const expected = Buffer.from(computed, "hex");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
