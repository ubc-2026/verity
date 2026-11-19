import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeRequestHash,
  commitResearchRequest,
  deriveNonce,
  generateSalt,
  hashContent,
  parseResearchRequest,
  parseResearchRequestJson,
  ResearchRequestError,
} from "../src/payments/researchRequest.ts";
import { StrictJsonError } from "../src/payments/strictJson.ts";
import {
  DEMO_EXPECTED_CONTENT_HASH,
  DEMO_NONCE,
  DEMO_REQUEST_HASH,
  DEMO_REQUEST_JSON,
  DEMO_RESPONSE_TEXT,
  DEMO_SALT,
} from "./fixtures/demoVector.ts";

const demoObject = () => JSON.parse(DEMO_REQUEST_JSON) as Record<string, any>;

describe("pinned test vector (ad091fc)", () => {
  it("reproduces the response hash", () => {
    assert.equal(hashContent(new TextEncoder().encode(DEMO_RESPONSE_TEXT)), DEMO_EXPECTED_CONTENT_HASH);
  });

  it("reproduces the request hash and nonce", () => {
    const commitment = commitResearchRequest(parseResearchRequestJson(DEMO_REQUEST_JSON), DEMO_SALT);
    assert.equal(commitment.requestHash, DEMO_REQUEST_HASH);
    assert.equal(commitment.nonce, DEMO_NONCE);
  });

  it("is independent of JSON key order and whitespace", () => {
    const reversed = (obj: Record<string, any>): Record<string, any> =>
      Object.fromEntries(
        Object.keys(obj)
          .reverse()
          .map((k) => [k, typeof obj[k] === "object" ? reversed(obj[k]) : obj[k]]),
      );
    const shuffled = JSON.stringify(reversed(demoObject()));
    assert.notEqual(shuffled, JSON.stringify(demoObject()));
    assert.equal(computeRequestHash(parseResearchRequestJson(shuffled)), DEMO_REQUEST_HASH);
    assert.equal(computeRequestHash(parseResearchRequestJson(JSON.stringify(demoObject(), null, 8))), DEMO_REQUEST_HASH);
  });
});

describe("binding", () => {
  const changes: Array<[string, (o: Record<string, any>) => void]> = [
    ["purchaseId", (o) => (o.purchaseId = "purchase-demo-002")],
    ["quoteId", (o) => (o.quoteId = "quote-demo-002")],
    ["merchantId", (o) => (o.merchantId = "other-merchant")],
    ["resourceUrl", (o) => (o.resourceUrl = "https://merchant.example/evidence/other")],
    ["parameters.contractId", (o) => (o.parameters.contractId = "demo-contract-002")],
    ["parameters.evidenceType", (o) => (o.parameters.evidenceType = "market_rules")],
    ["contentType", (o) => (o.contentType = "text/plain")],
    ["expectedContentHash", (o) => (o.expectedContentHash = `0x${"ab".repeat(32)}`)],
    ["chainId", (o) => (o.chainId = 1)],
    ["token", (o) => (o.token = "0x3600000000000000000000000000000000000001")],
    ["payer", (o) => (o.payer = "0x3333333333333333333333333333333333333333")],
    ["payTo", (o) => (o.payTo = "0x4444444444444444444444444444444444444444")],
    ["amount", (o) => (o.amount = "50001")],
    ["validAfter", (o) => (o.validAfter = 1795185001)],
    ["validBefore", (o) => (o.validBefore = 1795185301)],
  ];
  for (const [field, mutate] of changes) {
    it(`changing ${field} changes the request hash and nonce`, () => {
      const object = demoObject();
      mutate(object);
      const commitment = commitResearchRequest(parseResearchRequest(object), DEMO_SALT);
      assert.notEqual(commitment.requestHash, DEMO_REQUEST_HASH);
      assert.notEqual(commitment.nonce, DEMO_NONCE);
    });
  }

  it("changing the salt changes the nonce", () => {
    const salt = `0x${"00".repeat(31)}01` as const;
    assert.notEqual(deriveNonce(DEMO_REQUEST_HASH, salt), DEMO_NONCE);
  });

  it("rejects salts and hashes that are not 32 bytes", () => {
    assert.throws(() => deriveNonce(DEMO_REQUEST_HASH, `0x${"00".repeat(31)}`));
    assert.throws(() => deriveNonce(DEMO_REQUEST_HASH, new Uint8Array(33)), ResearchRequestError);
  });

  it("generates distinct 32-byte salts", () => {
    const a = generateSalt();
    const b = generateSalt();
    assert.match(a, /^0x[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });
});

describe("strict validation", () => {
  it("normalizes hex case once at the boundary", () => {
    const object = demoObject();
    object.expectedContentHash = object.expectedContentHash.toUpperCase().replace("0X", "0x");
    object.payer = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // valid EIP-55 checksum
    const request = parseResearchRequest(object);
    assert.equal(request.expectedContentHash, DEMO_EXPECTED_CONTENT_HASH);
    assert.equal(request.payer, "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
  });

  it("rejects duplicate keys at any depth", () => {
    assert.throws(() => parseResearchRequestJson(DEMO_REQUEST_JSON.replace('"amount": "50000"', '"amount": "1", "amount": "50000"')), StrictJsonError);
    assert.throws(
      () => parseResearchRequestJson(DEMO_REQUEST_JSON.replace('"contractId": "demo-contract-001"', '"contractId": "x", "contractId": "demo-contract-001"')),
      StrictJsonError,
    );
  });

  const invalid: Array<[string, (o: Record<string, any>) => void]> = [
    ["unknown top-level field", (o) => (o.extra = 1)],
    ["unknown parameter field", (o) => (o.parameters.extra = "x")],
    ["missing field", (o) => delete o.payTo],
    ["wrong version", (o) => (o.version = "verity-research-request-v2")],
    ["non-POST method", (o) => (o.method = "GET")],
    ["numeric amount", (o) => (o.amount = 50000)],
    ["amount with leading zero", (o) => (o.amount = "050000")],
    ["zero amount", (o) => (o.amount = "0")],
    ["decimal amount", (o) => (o.amount = "0.05")],
    ["amount above uint256", (o) => (o.amount = (1n << 256n).toString())],
    ["http URL", (o) => (o.resourceUrl = "http://merchant.example/evidence/resolution-source")],
    ["URL with query", (o) => (o.resourceUrl = "https://merchant.example/evidence/resolution-source?x=1")],
    ["URL with fragment", (o) => (o.resourceUrl = "https://merchant.example/evidence/resolution-source#x")],
    ["URL with credentials", (o) => (o.resourceUrl = "https://u:p@merchant.example/evidence/resolution-source")],
    ["non-canonical URL", (o) => (o.resourceUrl = "https://MERCHANT.example:443/evidence/resolution-source")],
    ["bad address checksum", (o) => (o.payer = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")],
    ["short address", (o) => (o.payTo = "0x2222")],
    ["short content hash", (o) => (o.expectedContentHash = "0xecb8")],
    ["fractional time", (o) => (o.validAfter = 1795185000.5)],
    ["string time", (o) => (o.validAfter = "1795185000")],
    ["empty window", (o) => (o.validBefore = o.validAfter)],
    ["string chainId", (o) => (o.chainId = "5042002")],
  ];
  for (const [label, mutate] of invalid) {
    it(`rejects ${label}`, () => {
      const object = demoObject();
      mutate(object);
      assert.throws(() => parseResearchRequest(object), ResearchRequestError);
    });
  }
});
