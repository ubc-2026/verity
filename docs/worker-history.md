# Connect the Verity Research API to Supabase

The existing `verity-research-api` Worker still serves its Gemini market and research routes. The new GET route is `/v1/market-history?instrument=<full Gemini instrument symbol>`. It returns up to 120 stored live observations in time order and can return an empty result. A missing or failed database binding returns HTTP 503.

## Cloudflare setup

1. The hosted Verity project already has the verified NOLOGIN role from `supabase/worker-history-role.sql`. For another environment, apply that SQL after the research schema. Create the dedicated `verity_history_worker` login with only login permission. Set its password through the database role form. Apply `supabase/worker-history-membership.sql` to grant the dedicated login only the quote-history role. Keep its password in the platform secret settings.
2. Production uses the `verity-market-history` Hyperdrive connection with `verify-full`. The repository's `wrangler.jsonc` binds it as `VERITY_HISTORY_DB`, enables Node.js compatibility, and keeps the existing `api.verityresearch.us` custom domain. Cloudflare stores the database password in Hyperdrive. Supabase's Data API stays off.
3. Release through the existing Cloudflare build from `main`. Git preview builds are disabled for this Worker. If enabling them later, use a separate preview configuration without the production Hyperdrive binding. Verify the custom domain and existing routes after deployment.

Use the stored San Francisco weather contract `GEMI-WXHIGH-SFO-2611200459-56TO57` for the hosted check. Verify the two records, the time source, a missing instrument, and a read-only failure case. The new route serves public market observations and carries no OAuth session or payment data.

See [Cloudflare's Supabase integration](https://developers.cloudflare.com/workers/databases/third-party-integrations/supabase/) and [Hyperdrive certificate verification](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/).
