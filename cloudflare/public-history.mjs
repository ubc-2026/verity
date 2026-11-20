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

function outcomeLabel(label, symbol) {
  const text = typeof label === "string" && label.trim() ? label.trim() : symbol;
  return Array.from(text.toWellFormed().replaceAll("\u0000", "")).slice(0, 180).join("") || symbol;
}

function allowedTimeBasis(value) {
  return value === "exchange" || value === "collector" ? value : "collector";
}

function allowedMarketState(value) {
  return value === "open" || value === "closed" || value === "unknown" ? value : "unknown";
}

function priceInRange(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 1) return null;
  return text;
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
      outcome_label: outcomeLabel(observation.outcomeLabel, observation.instrument),
      observed_at: observation.observedAtUtc,
      time_basis: allowedTimeBasis(observation.timeBasis),
      best_bid: priceInRange(observation.bestBid),
      best_ask: priceInRange(observation.bestAsk),
      market_state: allowedMarketState(observation.marketState),
    });
  }
  if (rows.length === 0) return 0;
  // Two statements. A quote INSERT in the same statement as the instrument
  // INSERT cannot see that instrument under row-level security.
  // The batch is sent as text and cast in SQL. A parameter the server types as jsonb is
  // JSON-encoded again by postgres.js, which turns the array into a JSON string.
  const batch = JSON.stringify(rows);
  await sql`
    INSERT INTO research.instruments (venue, external_instrument_id, outcome_label)
    SELECT DISTINCT ON (instrument) 'gemini-exchange', instrument, outcome_label
    FROM jsonb_to_recordset(${batch}::text::jsonb) AS t(instrument text, outcome_label text)
    ORDER BY instrument
    ON CONFLICT (venue, external_instrument_id) DO NOTHING
  `;
  await sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${batch}::text::jsonb) AS t(
        instrument text, observed_at timestamptz, time_basis text,
        best_bid numeric, best_ask numeric, market_state text
      )
    )
    INSERT INTO research.quote_snapshots
      (instrument_id, observed_at, observed_at_basis, source_mode, best_bid, best_ask, market_state)
    SELECT DISTINCT ON (i.id, n.observed_at)
      i.id, n.observed_at, n.time_basis, 'live', n.best_bid, n.best_ask, n.market_state
    FROM incoming n
    JOIN research.instruments i ON i.venue = 'gemini-exchange' AND i.external_instrument_id = n.instrument
    ORDER BY i.id, n.observed_at
    ON CONFLICT (instrument_id, source_mode, observed_at) DO NOTHING
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
