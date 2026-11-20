import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { AUTHORIZATION_USED_TOPIC, TRANSFER_TOPIC } from "../src/chain.ts";

test("the stream filter keeps USDC logs and every block header", () => {
  const source = readFileSync(new URL("../streams/arc-usdc-filter.js", import.meta.url), "utf8");
  assert.match(source, new RegExp(TRANSFER_TOPIC));
  assert.match(source, new RegExp(AUTHORIZATION_USED_TOPIC));

  const sandbox: { main?: (stream: unknown) => unknown } = {};
  runInContext(source, createContext(sandbox));
  const result = sandbox.main?.({
    data: [
      {
        block: { number: "0xa", hash: "0x" + "11".repeat(32), parentHash: "0x" + "10".repeat(32) },
        receipts: [
          {
            transactionHash: "0x" + "ab".repeat(32),
            status: "0x1",
            logs: [
              { address: "0x3600000000000000000000000000000000000000", topics: [TRANSFER_TOPIC], data: "0x01", logIndex: "0x0" },
              { address: "0x00000000000000000000000000000000000000aa", topics: [TRANSFER_TOPIC], data: "0x01", logIndex: "0x1" },
            ],
          },
          { transactionHash: "0x" + "cd".repeat(32), status: "0x1", logs: [] },
        ],
      },
    ],
    metadata: { network: "arc-testnet", blocks_reorged: null },
  }) as { data: Array<{ receipts: unknown[] }>; metadata: { network: string } };

  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]?.receipts.length, 1);
  assert.equal(result.metadata.network, "arc-testnet");
});
