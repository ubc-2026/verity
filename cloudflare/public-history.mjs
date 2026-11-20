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
  let recorded = 0;
  for (const observation of observations) {
    if (!validInstrument(observation.instrument)) continue;
    const inserted = await sql`
      INSERT INTO research.instruments (venue, external_instrument_id)
      SELECT 'gemini-exchange', ${observation.instrument}
      WHERE NOT EXISTS (
        SELECT 1 FROM research.instruments
        WHERE venue = 'gemini-exchange' AND external_instrument_id = ${observation.instrument}
      )
      RETURNING id
    `;
    let instrumentId = inserted[0]?.id;
    if (instrumentId == null) {
      const existing = await sql`
        SELECT id FROM research.instruments
        WHERE venue = 'gemini-exchange' AND external_instrument_id = ${observation.instrument}
      `;
      instrumentId = existing[0]?.id;
    }
    if (instrumentId == null) continue;
    await sql`
      INSERT INTO research.quote_snapshots
        (instrument_id, observed_at, observed_at_basis, source_mode, best_bid, best_ask, market_state)
      VALUES (
        ${instrumentId},
        ${observation.observedAtUtc},
        ${observation.timeBasis},
        'live',
        ${observation.bestBid},
        ${observation.bestAsk},
        ${observation.marketState}
      )
    `;
    recorded += 1;
  }
  return recorded;
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
