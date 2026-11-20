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
