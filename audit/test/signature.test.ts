import assert from "node:assert/strict";
import test from "node:test";
import { signWebhook, verifyWebhook } from "../src/signature.ts";

const secret = "stream-token";
const payload = JSON.stringify({ data: [], metadata: { network: "arc-testnet" } });

test("accepts a QuickNode HMAC over the uncompressed body", () => {
  const signature = signWebhook(secret, "nonce-1", "1700000000", payload);
  assert.equal(
    verifyWebhook({
      secret,
      nonce: "nonce-1",
      timestamp: "1700000000",
      payload,
      signature,
      nowSeconds: 1700000100,
      maxSkewSeconds: 300,
    }),
    true,
  );
});

test("rejects a tampered body, a stale timestamp, and a missing secret", () => {
  const signature = signWebhook(secret, "nonce-1", "1700000000", payload);
  assert.equal(
    verifyWebhook({
      secret,
      nonce: "nonce-1",
      timestamp: "1700000000",
      payload: payload + " ",
      signature,
      nowSeconds: 1700000000,
      maxSkewSeconds: 300,
    }),
    false,
  );
  assert.equal(
    verifyWebhook({
      secret,
      nonce: "nonce-1",
      timestamp: "1700000000",
      payload,
      signature,
      nowSeconds: 1700000000 + 301,
      maxSkewSeconds: 300,
    }),
    false,
  );
  assert.equal(
    verifyWebhook({
      secret: "",
      nonce: "nonce-1",
      timestamp: "1700000000",
      payload,
      signature,
      nowSeconds: 1700000000,
      maxSkewSeconds: 300,
    }),
    false,
  );
});
