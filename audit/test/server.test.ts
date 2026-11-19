import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { Ledger } from "../src/ledger.ts";
import type { OverdueEvent } from "../src/overdue.ts";
import { AuditServer } from "../src/server.ts";
import { signWebhook } from "../src/signature.ts";
import { authorizationLog, block, payload, purchase, receipt, transferLog, word } from "./fixture.ts";

const secret = "qn-secret";
const readToken = "read-token";
const writeToken = "write-token";

async function start(options: { now?: () => Date; sink?: (event: OverdueEvent) => Promise<void> } = {}) {
  const server = new AuditServer({
    ledger: new Ledger(undefined, { finalityDepth: 1, expectedNetwork: "arc-testnet" }),
    quicknodeSecret: secret,
    readToken,
    writeToken,
    now: options.now ?? (() => new Date("2026-11-18T12:00:00Z")),
    sink: options.sink,
    sweepOnWebhook: false,
  });
  await server.listen(0);
  return server;
}

async function postJson(port: number, path: string, body: unknown, token?: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("the webhook requires a current QuickNode signature and then reconciles", async () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const server = await start({ now: () => now });
  try {
    const registered = await postJson(server.address().port, "/purchases", purchase(), writeToken);
    assert.equal(registered.status, 201);

    const body = JSON.stringify(
      payload([
        block(10, word(10), word(9), [receipt(word(100), [authorizationLog(purchase().payer, word(1)), transferLog(purchase().payer, purchase().payTo, 50000n)])]),
        block(11, word(11), word(10)),
      ]),
    );
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const unsigned = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/quicknode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(unsigned.status, 200);
    assert.equal((await unsigned.json()).check, true);

    const forged = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/quicknode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qn-nonce": "n-1",
        "x-qn-timestamp": timestamp,
        "x-qn-signature": "ab",
      },
      body,
    });
    assert.equal(forged.status, 401);

    const signed = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/quicknode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qn-nonce": "n-1",
        "x-qn-timestamp": timestamp,
        "x-qn-signature": signWebhook(secret, "n-1", timestamp, body),
      },
      body,
    });
    assert.equal(signed.status, 200);

    const view = await fetch(`http://127.0.0.1:${server.address().port}/purchases/purchase-1`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    assert.equal(view.status, 200);
    const record = await view.json();
    assert.equal(record.ledgerStatus, "Paid, delivery missing");
    assert.equal(record.settlementConfirmed, true);
    assert.equal(record.txHash, word(100));
    assert.equal(record.environment, "arc-testnet");
    assert.equal(record.amountBaseUnits, "50000");

    const denied = await fetch(`http://127.0.0.1:${server.address().port}/purchases/purchase-1`);
    assert.equal(denied.status, 401);
  } finally {
    await server.close();
  }
});

test("gzip webhook bodies are verified after decompression", async () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const server = await start({ now: () => now });
  try {
    const raw = JSON.stringify(payload([block(4, word(4), word(3))]));
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/quicknode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "x-qn-nonce": "n-2",
        "x-qn-timestamp": timestamp,
        "x-qn-signature": signWebhook(secret, "n-2", timestamp, raw),
      },
      body: gzipSync(raw),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).blocks, 1);
  } finally {
    await server.close();
  }
});

test("a verified delivery and a later sweep emit one overdue event", async () => {
  const sent: OverdueEvent[] = [];
  const now = new Date("2026-11-18T18:00:00Z");
  const server = await start({
    now: () => now,
    sink: async (event) => {
      sent.push(event);
    },
  });
  try {
    const port = server.address().port;
    await postJson(
      port,
      "/purchases",
      purchase({ deliveryDeadlineUtc: "2026-11-18T17:00:00Z", environment: "fixture" }),
      writeToken,
    );
    const body = JSON.stringify(
      payload([
        block(10, word(10), word(9), [
          receipt(word(100), [authorizationLog(purchase().payer, word(1)), transferLog(purchase().payer, purchase().payTo, 50000n)]),
        ]),
        block(11, word(11), word(10)),
      ]),
    );
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const webhook = await fetch(`http://127.0.0.1:${port}/webhooks/quicknode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qn-nonce": "n-3",
        "x-qn-timestamp": timestamp,
        "x-qn-signature": signWebhook(secret, "n-3", timestamp, body),
      },
      body,
    });
    assert.equal(webhook.status, 200);
    assert.equal(await server.sweep(), 1);
    assert.equal(sent[0]?.schema, "verity.overdue_delivery.v1");
    assert.equal(await server.sweep(), 0);

    const delivered = await postJson(port, "/purchases/purchase-1/delivery", { ok: true, contentHash: word(9) }, writeToken);
    assert.equal(delivered.status, 200);
    assert.equal((await delivered.json()).ledgerStatus, "Reconciled");

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Audit ledger/);
  } finally {
    await server.close();
  }
});
