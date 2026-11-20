/**
 * DEMO FIXTURE: shared test vector pinned in README commit
 * ad091fc15a1d909fa0062a341dc9fc35bad4dd4e. These values are not production
 * configuration. Real requests use a fresh CSPRNG salt.
 */
export const DEMO_REQUEST_JSON = `{
  "version": "verity-research-request-v1",
  "purchaseId": "purchase-demo-001",
  "quoteId": "quote-demo-001",
  "merchantId": "verity-demo-merchant",
  "method": "POST",
  "resourceUrl": "https://merchant.example/evidence/resolution-source",
  "parameters": {
    "contractId": "demo-contract-001",
    "evidenceType": "resolution_source"
  },
  "contentType": "application/json",
  "expectedContentHash": "0xecb8d0303298a3bff971405264cc3670f3297da1468bd6c39a3e32e5abd2dda9",
  "chainId": 5042002,
  "token": "0x3600000000000000000000000000000000000000",
  "payer": "0x1111111111111111111111111111111111111111",
  "payTo": "0x2222222222222222222222222222222222222222",
  "amount": "50000",
  "validAfter": 1795185000,
  "validBefore": 1795185300
}`;

/** UTF-8 response bytes, no trailing newline. */
export const DEMO_RESPONSE_TEXT = `{"source":"mock","summary":"Cutoff policy excerpt for the demo."}`;

export const DEMO_SALT = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
export const DEMO_EXPECTED_CONTENT_HASH = "0xecb8d0303298a3bff971405264cc3670f3297da1468bd6c39a3e32e5abd2dda9";
export const DEMO_REQUEST_HASH = "0x7ce16c2335bbb15089c7c81b64e93a8605d19730e02d368b2ac4a333c2c38c0f";
export const DEMO_NONCE = "0x310ef615ef725fa65943c2eb63e52ddd57c17f689b4b99e6aa05fec5e1f4968c";
