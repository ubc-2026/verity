import postgres from "postgres";

const instrumentSymbol = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;

export function validInstrument(instrument) {
  return typeof instrument === "string" && instrumentSymbol.test(instrument);
}

export async function readHistory(sql, instrument) {
  const rows = await sql`
    SELECT q.observed_at, q.observed_at_basis, q.best_bid::text, q.best_ask::text, q.market_state
    FROM research.instruments i
    JOIN research.quote_snapshots q ON q.instrument_id = i.id
    WHERE i.venue = 'gemini-exchange'
      AND i.external_instrument_id = ${instrument}
      AND q.source_mode = 'live'
    ORDER BY q.observed_at DESC, q.id DESC
    LIMIT 120
  `;
  return rows.reverse().map((row) => ({
    observedAtUtc: new Date(row.observed_at).toISOString(),
    timeBasis: row.observed_at_basis,
    bestBid: row.best_bid,
    bestAsk: row.best_ask,
    marketState: row.market_state,
  }));
}

export async function recordObservations(sql, observations) {
  const seen = new Set();
  const rows = [];
  for (const observation of observations) {
    if (!validInstrument(observation.instrument)) continue;
    const key = `${observation.instrument}\0${observation.observedAtUtc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      instrument: observation.instrument,
      observed_at: observation.observedAtUtc,
      time_basis: observation.timeBasis,
      best_bid: observation.bestBid,
      best_ask: observation.bestAsk,
      market_state: observation.marketState,
    });
  }
  if (rows.length === 0) return 0;
  // One statement: insert any missing instruments, then insert quotes.
  // Both ON CONFLICT clauses need the unique indexes in supabase/worker-history-record.sql.
  await sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS t(
        instrument text,
        observed_at timestamptz,
        time_basis text,
        best_bid numeric,
        best_ask numeric,
        market_state text
      )
    ),
    upserted AS (
      INSERT INTO research.instruments (venue, external_instrument_id)
      SELECT DISTINCT 'gemini-exchange', instrument FROM incoming
      ON CONFLICT (venue, external_instrument_id) DO NOTHING
      RETURNING id, venue, external_instrument_id
    ),
    known AS (
      SELECT id, venue, external_instrument_id FROM upserted
      UNION
      SELECT i.id, i.venue, i.external_instrument_id
      FROM research.instruments i
      JOIN (SELECT DISTINCT instrument FROM incoming) n
        ON i.venue = 'gemini-exchange' AND i.external_instrument_id = n.instrument
    )
    INSERT INTO research.quote_snapshots
      (instrument_id, observed_at, observed_at_basis, source_mode, best_bid, best_ask, market_state)
    SELECT DISTINCT ON (k.id, n.observed_at)
      k.id, n.observed_at, n.time_basis, 'live', n.best_bid, n.best_ask, n.market_state
    FROM incoming n
    JOIN known k ON k.external_instrument_id = n.instrument
    ORDER BY k.id, n.observed_at
    ON CONFLICT (instrument_id, observed_at) DO NOTHING
  `;
  return rows.length;
}

export async function recordHyperdriveObservations(connectionString, observations) {
  const sql = postgres(connectionString, { max: 1, connect_timeout: 5, fetch_types: false, prepare: true });
  try {
    return await recordObservations(sql, observations);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export async function readHyperdriveHistory(connectionString, instrument) {
  // Hyperdrive handles connection pooling across requests. Keep protocol
  // prepared statements enabled for Hyperdrive transaction pooling.
  const sql = postgres(connectionString, { max: 1, connect_timeout: 5, fetch_types: false, prepare: true });
  try {
    return await readHistory(sql, instrument);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
