import assert from "node:assert/strict";
import { test } from "node:test";
import { ARC_USDC } from "../src/chain.ts";
import { observationsFromStream } from "../src/portalClient.ts";
import { PAYER, PAY_TO, authorizationLog, block, payload, receipt, transferLog, word } from "./fixture.ts";

test("the portal report keeps authorization tickets and the chain head", () => {
  const report = observationsFromStream(
    payload([
      block(10, word(10), word(9), [receipt(word(100), [authorizationLog(PAYER, word(1)), transferLog(PAYER, PAY_TO, 50000n)])]),
      block(11, word(11), word(10)),
    ]),
    ARC_USDC,
  );
  assert.equal(report.head, 11);
  assert.equal(report.observations.length, 2);
  assert.deepEqual(
    report.observations.map((item) => item.kind),
    ["transfer", "authorization"],
  );
  assert.equal(report.observations[0]?.amountBaseUnits, "50000");
  assert.equal(report.observations[1]?.nonce, word(1));
});
