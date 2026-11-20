# Connect the Verity Research API to Supabase

The existing `verity-research-api` Worker still serves its Gemini market and research routes. `GET /v1/market-history?instrument=<full Gemini instrument symbol>` returns up to 120 observations in time order and can return an empty result. A missing or failed database binding returns HTTP 503, unless this isolate has already seen that instrument on a market or research fetch.

`/v1/markets`, `/v1/markets/{eventTicker}`, and `/v1/research` return `mode`, `live`, `source`, and `fetchedAt`. `/v1/market-history` also returns `newestObservedAtUtc`. `mode` is `live` only when this isolate has an observation for that instrument from the last 60 seconds. Rows read from the database are `mode: "stored"` and `live: false`, including rows that were collected recently by another isolate. `newestObservedAtUtc` is the newest timestamp in the response, or `null` when there are no rows. An upstream failure on a market route is HTTP 502 with `mode: "unavailable"` and `live: false`. `/v1/research` is built from events Gemini reports as active. When that read fails, the route returns `mode: "fallback"`, `live: false`, and no cached brief.

Public requests do not write to the database. Each isolate keeps an in-memory copy of quotes it has just fetched. That copy is not shared with other isolates: a history read on a different isolate does not see it. The copy holds at most 2,000 instruments and evicts the oldest instrument first. Each instrument keeps at most 120 quotes.

Durable collection is a Cron Trigger, `*/2 * * * *`, declared in `wrangler.jsonc`. The trigger does nothing until the next deploy of this Worker. On each run the scheduled handler reads at most 20 active Gemini events and inserts quotes that this isolate has not written in the last 60 seconds. The insert is two statements, so a new instrument is visible to the quote insert under row-level security. It relies on unique keys that are already in production: `research.instruments (venue, external_instrument_id)` and `research.quote_snapshots (instrument_id, source_mode, observed_at)`. A new instrument stores `outcome_label` from the contract label, or the symbol when the label is blank, cut to 180 characters. `observed_at_basis` is `collector`. `market_state` is `open`, `closed`, or `unknown`. A price outside 0 to 1 is omitted so the rest of the batch still inserts. The owner applies `supabase/worker-history-record.sql` to grant the writer role. Nothing in CI or the Worker runs it. Until `verity_history_worker` has that role, the insert fails, is logged once without the connection string, and market responses stay successful.

Production already has a separate collector, `verity_market_collector`, with `market_collection_slots`. The owner can decide whether this Worker's cron should run beside that collector.

The writer role `verity_history_writer` needs `USAGE` on schema `research`, and `SELECT` and `INSERT` on `research.instruments` and `research.quote_snapshots`. Both `id` columns are identity columns, so the role is not granted sequence privileges. It does not need `UPDATE` or `DELETE`. The migration grants those privileges and, when the login exists, grants the role to `verity_history_worker`.

Recommended Cloudflare rate-limiting rule, created in the dashboard for the zone that serves `api.verityresearch.us`. It is not part of the Worker and takes effect when the owner saves it:

- Expression: `(http.host eq "api.verityresearch.us" and starts_with(http.request.uri.path, "/v1/"))`
- Characteristic: IP
- Period: 60 requests per 1 minute
- Action: Block

Request handlers do not write, so this rule is a limit on Gemini egress, not on database load.

## Cloudflare setup

1. The hosted Verity project already has the verified NOLOGIN role from `supabase/worker-history-role.sql`. For another environment, apply that SQL after the research schema. Create the dedicated `verity_history_worker` login with only login permission. Set its password through the database role form. Apply `supabase/worker-history-membership.sql` to grant the dedicated login only the quote-history role. Keep its password in the platform secret settings.
2. Production uses the `verity-market-history` Hyperdrive connection with `verify-full`. The repository's `wrangler.jsonc` binds it as `VERITY_HISTORY_DB`, enables Node.js compatibility, and keeps the existing `api.verityresearch.us` custom domain. Cloudflare stores the database password in Hyperdrive. Supabase's Data API stays off.
3. Release through the existing Cloudflare build from `main`. Git preview builds are disabled for this Worker. If enabling them later, use a separate preview configuration without the production Hyperdrive binding. Verify the custom domain and existing routes after deployment.

Use the stored San Francisco weather contract `GEMI-WXHIGH-SFO-2611200459-56TO57` for the hosted check. Verify the two records, the time source, a missing instrument, and a read-only failure case. The new route serves public market observations and carries no OAuth session or payment data.

See [Cloudflare's Supabase integration](https://developers.cloudflare.com/workers/databases/third-party-integrations/supabase/) and [Hyperdrive certificate verification](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/).
