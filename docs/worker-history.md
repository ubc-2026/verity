# Connect the Verity Research API to Supabase

The existing `verity-research-api` Worker still serves its Gemini market and research routes. The new GET route is `/v1/market-history?instrument=<full Gemini instrument symbol>`. It returns up to 120 stored live observations in time order and can return an empty result. A missing or failed database binding returns HTTP 503, unless this isolate has already recorded observations for that instrument from a live Gemini fetch.

`/v1/markets`, `/v1/markets/{eventTicker}`, `/v1/research`, and `/v1/market-history` each return `mode`, `live`, `source`, and `fetchedAt`. `mode` is `live` only for data just read from Gemini, or for history rows that were collected from those reads. An upstream failure on a market route is HTTP 502 with `mode: "unavailable"` and `live: false`. `/v1/research` is built from events Gemini reports as active. When that read fails, the route returns `mode: "fallback"`, `live: false`, and no cached brief. A fallback is never labeled live.

A successful market or research fetch records each contract quote. The isolate keeps those observations and serves them from `/v1/market-history`. When `VERITY_HISTORY_DB` is configured, the Worker also inserts them into `research.quote_snapshots` with `source_mode = 'live'` and `observed_at_basis = 'worker-fetch'`. The hosted login inherits the read-only `verity_history_reader` role, so a refused insert is logged once without secrets and the market response still succeeds. Durable collection needs `INSERT` on `research.instruments` and `research.quote_snapshots` for that role. A failed insert does not change `mode` on the market response.

## Cloudflare setup

1. The hosted Verity project already has the verified NOLOGIN role from `supabase/worker-history-role.sql`. For another environment, apply that SQL after the research schema. Create the dedicated `verity_history_worker` login with only login permission. Set its password through the database role form. Apply `supabase/worker-history-membership.sql` to grant the dedicated login only the quote-history role. Keep its password in the platform secret settings.
2. Production uses the `verity-market-history` Hyperdrive connection with `verify-full`. The repository's `wrangler.jsonc` binds it as `VERITY_HISTORY_DB`, enables Node.js compatibility, and keeps the existing `api.verityresearch.us` custom domain. Cloudflare stores the database password in Hyperdrive. Supabase's Data API stays off.
3. Release through the existing Cloudflare build from `main`. Git preview builds are disabled for this Worker. If enabling them later, use a separate preview configuration without the production Hyperdrive binding. Verify the custom domain and existing routes after deployment.

Use the stored San Francisco weather contract `GEMI-WXHIGH-SFO-2611200459-56TO57` for the hosted check. Verify the two records, the time source, a missing instrument, and a read-only failure case. The new route serves public market observations and carries no OAuth session or payment data.

See [Cloudflare's Supabase integration](https://developers.cloudflare.com/workers/databases/third-party-integrations/supabase/) and [Hyperdrive certificate verification](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/).
