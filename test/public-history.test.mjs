import assert from "node:assert/strict";
import { it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readHistory, recordObservations } from "../cloudflare/public-history.mjs";

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

it("records a live quote and reads it back in time order", async () => {
  const database = await PGlite.create();
  try {
    await database.exec(`
      CREATE SCHEMA research;
      CREATE TABLE research.instruments (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        venue text NOT NULL,
        external_instrument_id text NOT NULL,
        outcome_label text NOT NULL,
        UNIQUE (venue, external_instrument_id)
      );
      CREATE TABLE research.quote_snapshots (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        instrument_id bigint NOT NULL REFERENCES research.instruments(id),
        observed_at timestamptz NOT NULL,
        observed_at_basis text NOT NULL CHECK (observed_at_basis IN ('exchange', 'collector')),
        source_mode text NOT NULL,
        best_bid numeric CHECK (best_bid IS NULL OR (best_bid >= 0 AND best_bid <= 1)),
        best_ask numeric CHECK (best_ask IS NULL OR (best_ask >= 0 AND best_ask <= 1)),
        market_state text NOT NULL CHECK (market_state IN ('open', 'closed', 'unknown')),
        UNIQUE (instrument_id, source_mode, observed_at)
      );
    `);
    let queries = 0;
    const sql = async (strings, ...values) => {
      queries += 1;
      const query = strings.reduce((text, part, index) => index === 0 ? part : `${text}$${index}${part}`, "");
      return (await database.query(query, values)).rows;
    };
    const symbol = "GEMI-WXHIGH-BOS-2611210459-66TO67";
    const batch = [
      { instrument: symbol, observedAtUtc: "2026-11-20T05:25:56Z", timeBasis: "worker-fetch", bestBid: "0.43", bestAsk: "0.50", marketState: "open" },
      { instrument: symbol, observedAtUtc: "2026-11-20T05:26:56Z", timeBasis: "worker-fetch", bestBid: "0.44", bestAsk: "0.51", marketState: "open" },
      { instrument: "not a symbol", observedAtUtc: "2026-11-20T05:26:56Z", timeBasis: "worker-fetch", bestBid: "0.10", bestAsk: "0.20", marketState: "open" },
    ];
    const recorded = await recordObservations(sql, batch);
    assert.equal(recorded, 2);
    assert.equal(queries, 1);
    assert.equal(await recordObservations(sql, batch), 2);
    assert.equal(queries, 2);
    assert.deepEqual(await readHistory(sql, symbol), [
      { observedAtUtc: "2026-11-20T05:25:56.000Z", timeBasis: "collector", bestBid: "0.43", bestAsk: "0.50", marketState: "open" },
      { observedAtUtc: "2026-11-20T05:26:56.000Z", timeBasis: "collector", bestBid: "0.44", bestAsk: "0.51", marketState: "open" },
    ]);
  } finally {
    await database.close();
  }
});

it("stores labels, collector time, and known market states, and drops prices outside 0 to 1", async () => {
  const database = await PGlite.create();
  try {
    await database.exec(`
      CREATE SCHEMA research;
      CREATE TABLE research.instruments (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        venue text NOT NULL,
        external_instrument_id text NOT NULL,
        outcome_label text NOT NULL,
        UNIQUE (venue, external_instrument_id)
      );
      CREATE TABLE research.quote_snapshots (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        instrument_id bigint NOT NULL REFERENCES research.instruments(id),
        observed_at timestamptz NOT NULL,
        observed_at_basis text NOT NULL CHECK (observed_at_basis IN ('exchange', 'collector')),
        source_mode text NOT NULL,
        best_bid numeric CHECK (best_bid IS NULL OR (best_bid >= 0 AND best_bid <= 1)),
        best_ask numeric CHECK (best_ask IS NULL OR (best_ask >= 0 AND best_ask <= 1)),
        market_state text NOT NULL CHECK (market_state IN ('open', 'closed', 'unknown')),
        UNIQUE (instrument_id, source_mode, observed_at)
      );
    `);
    const sql = async (strings, ...values) => {
      const query = strings.reduce((text, part, index) => index === 0 ? part : `${text}$${index}${part}`, "");
      return (await database.query(query, values)).rows;
    };
    const labeled = "GEMI-EDGE-LABELED";
    const fallback = "GEMI-EDGE-FALLBACK";
    const longLabel = `Boston ${"x".repeat(200)}`;
    await recordObservations(sql, [
      {
        instrument: labeled,
        outcomeLabel: longLabel,
        observedAtUtc: "2026-11-20T06:00:00Z",
        timeBasis: "worker-fetch",
        bestBid: "1.5",
        bestAsk: "-0.01",
        marketState: "post_only",
      },
      {
        instrument: fallback,
        observedAtUtc: "2026-11-20T06:00:00Z",
        timeBasis: "exchange",
        bestBid: "0",
        bestAsk: "1",
        marketState: "closed",
      },
    ]);
    await recordObservations(sql, [
      {
        instrument: labeled,
        outcomeLabel: longLabel,
        observedAtUtc: "2026-11-20T06:00:00Z",
        timeBasis: "worker-fetch",
        bestBid: "0.40",
        bestAsk: "0.50",
        marketState: "open",
      },
    ]);

    const instruments = await sql`
      SELECT external_instrument_id, outcome_label, char_length(outcome_label)::int AS label_length
      FROM research.instruments
      ORDER BY external_instrument_id
    `;
    assert.deepEqual(instruments, [
      { external_instrument_id: fallback, outcome_label: fallback, label_length: fallback.length },
      { external_instrument_id: labeled, outcome_label: longLabel.slice(0, 180), label_length: 180 },
    ]);
    assert.deepEqual(await readHistory(sql, labeled), [{
      observedAtUtc: "2026-11-20T06:00:00.000Z",
      timeBasis: "collector",
      bestBid: null,
      bestAsk: null,
      marketState: "unknown",
    }]);
    assert.deepEqual(await readHistory(sql, fallback), [{
      observedAtUtc: "2026-11-20T06:00:00.000Z",
      timeBasis: "exchange",
      bestBid: "0",
      bestAsk: "1",
      marketState: "closed",
    }]);
  } finally {
    await database.close();
  }
});
