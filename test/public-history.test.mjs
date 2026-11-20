import assert from "node:assert/strict";
import { it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readHistory } from "../cloudflare/public-history.mjs";

it("returns the latest 120 observations in order when timestamps tie at the cutoff", async () => {
  const database = await PGlite.create();
  try {
    // Allow tied timestamps in this fixture to exercise the reader's secondary ordering.
    await database.exec(`
      CREATE SCHEMA research;
      CREATE TABLE research.instruments (
        id bigint PRIMARY KEY,
        venue text NOT NULL,
        external_instrument_id text NOT NULL
      );
      CREATE TABLE research.quote_snapshots (
        id bigint PRIMARY KEY,
        instrument_id bigint NOT NULL REFERENCES research.instruments(id),
        observed_at timestamptz NOT NULL,
        observed_at_basis text NOT NULL,
        source_mode text NOT NULL,
        best_bid numeric,
        best_ask numeric,
        market_state text NOT NULL
      );
      INSERT INTO research.instruments VALUES (1, 'gemini-exchange', 'GEMI-CUTOFF');
      INSERT INTO research.quote_snapshots
        (id, instrument_id, observed_at, observed_at_basis, source_mode, best_bid, best_ask, market_state)
      SELECT n + 1, 1, timestamptz '2026-11-20 00:00:00Z' + greatest(n - 1, 0) * interval '1 second',
        'collector', 'live', n * 0.001, 0.99, 'open'
      FROM generate_series(0, 120) AS n;
      -- Prefer an index plan that would pick the lower ID first without a tie-breaker.
      CREATE INDEX quotes_by_time ON research.quote_snapshots (observed_at DESC, id ASC);
      SET enable_sort = off;
    `);

    const sql = async (strings, ...values) => {
      const query = strings.reduce((text, part, index) => index === 0 ? part : `${text}$${index}${part}`, "");
      return (await database.query(query, values)).rows;
    };
    const start = Date.parse("2026-11-20T00:00:00Z");
    const expected = Array.from({ length: 120 }, (_, index) => ({
      observedAtUtc: new Date(start + index * 1_000).toISOString(),
      timeBasis: "collector",
      bestBid: `0.${String(index + 1).padStart(3, "0")}`,
      bestAsk: "0.99",
      marketState: "open",
    }));

    assert.deepEqual(await readHistory(sql, "GEMI-CUTOFF"), expected);
  } finally {
    await database.close();
  }
});
