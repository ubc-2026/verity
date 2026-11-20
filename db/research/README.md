# Research store (Postgres)

The research store keeps market history for the website: instruments, quote snapshots, versioned source documents and append-only assessment versions. It lives in a private `research` schema. The payment, reservation, approval and settlement stores stay in SQLite and are not touched.

It runs in one of two places:

- **Embedded Postgres (PGlite), the default.** `npm run app` opens `.verity/research-pg` (gitignored), applies the migration, and ingests the FIXTURE slice. No credentials are needed. History survives a restart.
- **A real Postgres server.** Set `VERITY_RESEARCH_READ_URL` (and `VERITY_RESEARCH_INGEST_URL` for writes). The app server never migrates a server. This was tested against Postgres 17 in a local Docker container. It has not been run against Supabase.

## Schema

| Table | Key | What it holds |
| --- | --- | --- |
| `instruments` | `(exchange, instrument_id, outcome_id)`, for example `gemini`, `WXHIGH-NYC-2611190459`, `GEMI-WXHIGH-NYC-2611190459-62TO63` | Question, outcome label, category, expiry, settlement source, terms link, data label |
| `instrument_aliases` | `alias` | Other names for an outcome: the Verity contract ID, the venue's contract ID |
| `quote_snapshots` | `source_identity` (hash of the canonical input) | Provider, venue time, capture time or date, bid, ask, last trade, market state, quote state, implied probability, provenance |
| `source_documents` | `(source_key, version)`, and `(source_key, content_sha256)` for replays | Rules text, venue records, evidence. A new version is added only when the bytes change. Evidence records its verification state |
| `assessments` | `assessment_key`, and `(instrument, seq)` | Rubric version, analyst, the quote snapshot read, rating, scores, cited claims (with a server-checked `supported` flag), evidence gap, decision, the triggering evidence, changes, the parent version |
| `assessment_sources` | `(assessment, source_document)` | Which source versions each assessment read |

Rules the database enforces, whatever the client does:

- **Prices.** A price is between 0 and 1. The quote state must match the book. Only a two-sided, uncrossed, open book has an implied probability, and it must equal the rounded mid. Stale is worked out when the row is read, from the capture time.
- **Append-only.** Update, delete and truncate are refused for every role, the owner included.
- **Lineage.** One original per instrument. A reassessment must extend the latest version of the same instrument and name an evidence document for it.
- **Traceability.** A changed finding, score or rating needs evidence marked `verified`. Unverified or rejected evidence can only leave the findings as they were.
- **Hashes.** A source document's hash must match its bytes. A source key cannot move to another instrument.

### Roles and grants

| Role | Can | Cannot |
| --- | --- | --- |
| `verity_research_ingest` (no login) | Select and insert the base tables | Update, delete, create objects, read `schema_migrations`, touch any other schema |
| `verity_research_reader` (no login) | Select the four display views and `alias_display` | Read base tables, provenance, verification details or purchased evidence bytes; write anything |
| `anon`, `authenticated`, `service_role`, `PUBLIC` | Nothing in `research` | Everything |

Row-level security is on for every base table. Its only policies are for the ingest role, so a grant added by mistake still returns no rows. The display views run as their owner and leave out `provenance`, `verification` and the text of evidence documents. The server holds the connection strings; responses never include them.

## API (read-only)

| Route | Returns |
| --- | --- |
| `GET /api/research/instruments` | Each instrument with its quote and assessment counts |
| `GET /api/research/instruments/:exchange/:instrumentId/:outcomeId` | `instrument`, `market` (exchange-implied probability: `current` and `history`), `resolutionRisk` (settlement-risk rating: `versions`, `latest`, `comparison`), `sources` |
| `GET /api/research/aliases/:alias` | `{ key }` for a Verity or venue contract ID |

Any other method returns 405. A malformed key returns 400. `site/src/research-preview.json` is a full sample response.

## Migrate

Local embedded database:

```bash
npm run research:migrate -- status --pglite .verity/research-pg
npm run research:migrate -- apply  --pglite .verity/research-pg
```

A server (only after the owners have reviewed the target project and the SQL):

1. Put the schema owner's connection string in `.env.research` (gitignored) as `VERITY_RESEARCH_MIGRATE_URL`. The script reads that file, or the file named by `VERITY_RESEARCH_ENV_FILE`. It never reads the payment env file.
2. `npm run research:migrate -- plan` prints the target (host, port, database; never the credentials), each pending migration's checksum, and its SQL.
3. `npm run research:migrate -- apply --confirm-target HOST:PORT/DB --reviewed sha256:<checksum>`. Without the exact target and the reviewed checksum, it refuses.
4. As the owner, create one login role per server process and grant it one group role. Choose the passwords outside git:

   ```sql
   create role verity_ingest_login login password '<set by the owner>' in role verity_research_ingest;
   create role verity_reader_login login password '<set by the owner>' in role verity_research_reader;
   ```

5. Give the ingest server `VERITY_RESEARCH_INGEST_URL` and the website API `VERITY_RESEARCH_READ_URL`. Run `npm run research:ingest`. A second run reports every record as replayed.

The migration is repeatable: running the SQL again changes nothing, and the runner records a checksum, so an edited migration is refused as drift.

## Roll back

Rollback deletes every research record. Back up first.

```bash
pg_dump --schema=research --format=custom --file=research-0001.dump "$VERITY_RESEARCH_MIGRATE_URL"
npm run research:migrate -- rollback --version 0001 --confirm-target HOST:PORT/DB --i-have-a-backup
```

The down file drops the `research` schema and the two group roles, which also removes the login roles' memberships. Drop the login roles yourself if you no longer need them.

To restore the backup instead of re-applying an empty schema: recreate the two group roles (`create role verity_research_ingest nologin; create role verity_research_reader nologin;`), grant them to the login roles again, then run `pg_restore --dbname=<database> research-0001.dump`. That brings back the schema, the rows, the triggers, the grants and the migration ledger. This cycle (dump, rollback, restore, replayed ingest adding nothing) was run on the local Postgres 17 container.

## Supabase: what is left to do

None of this has been done. It needs the owners.

1. Choose the project and review this SQL. Run `plan` against it and compare the target.
2. Use the direct connection or the session pooler for the migration and for both servers. The pooler's user name has the form `role.<project-ref>`, so the login roles become `verity_ingest_login.<project-ref>` there. Add `sslmode=require` to each URL, or `verify-full` with the Supabase CA certificate.
3. Keep `research` out of the Data API's exposed schemas (Settings, API, Exposed schemas). The migration gives `anon`, `authenticated` and `service_role` nothing, and RLS stays on.
4. After applying, run the Security Advisor, then confirm as the owner:

   ```sql
   select grantee, table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'research' order by 1, 2;
   set role anon; select * from research.instrument_display; -- expect permission denied
   reset role;
   ```

5. Confirm that the owner role there can create roles and that the display views read through RLS as their owner. Both were checked on Postgres 17 and PGlite, not on Supabase.
6. Run `npm test` with `VERITY_RESEARCH_TEST_PG_URL` pointed at a disposable local server, never at the project.
