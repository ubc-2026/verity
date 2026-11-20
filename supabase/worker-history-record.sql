-- Owner-applied migration for scheduled quote collection.
-- Do not run this from CI, from the Worker, or against a database until the
-- owner has reviewed it. Applying it creates the unique indexes the Worker's
-- ON CONFLICT clauses require and grants INSERT to a separate writer role.
-- The read-only verity_history_reader role is unchanged.
--
-- The Worker login keeps working as a reader if this file is not applied.
-- Collection then fails, is logged once, and does not change market responses.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS instruments_venue_external_id
  ON research.instruments (venue, external_instrument_id);

CREATE UNIQUE INDEX IF NOT EXISTS quote_snapshots_instrument_observed_at
  ON research.quote_snapshots (instrument_id, observed_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verity_history_writer') THEN
    CREATE ROLE verity_history_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA research TO verity_history_writer;
GRANT SELECT, INSERT ON research.instruments, research.quote_snapshots TO verity_history_writer;

-- Identity and serial columns read these sequences on INSERT.
DO $$
DECLARE
  seq text;
BEGIN
  FOREACH seq IN ARRAY ARRAY[
    pg_get_serial_sequence('research.instruments', 'id'),
    pg_get_serial_sequence('research.quote_snapshots', 'id')
  ]
  LOOP
    IF seq IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO verity_history_writer', seq);
    END IF;
  END LOOP;
END
$$;

-- Policies apply only when row-level security is enabled on the table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'research' AND tablename = 'instruments' AND policyname = 'worker_write_instruments_select'
  ) THEN
    CREATE POLICY worker_write_instruments_select ON research.instruments
      FOR SELECT TO verity_history_writer USING (venue = 'gemini-exchange');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'research' AND tablename = 'instruments' AND policyname = 'worker_write_instruments_insert'
  ) THEN
    CREATE POLICY worker_write_instruments_insert ON research.instruments
      FOR INSERT TO verity_history_writer WITH CHECK (venue = 'gemini-exchange');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'research' AND tablename = 'quote_snapshots' AND policyname = 'worker_write_quotes_select'
  ) THEN
    CREATE POLICY worker_write_quotes_select ON research.quote_snapshots
      FOR SELECT TO verity_history_writer USING (
        source_mode = 'live' AND EXISTS (
          SELECT 1 FROM research.instruments i
          WHERE i.id = quote_snapshots.instrument_id AND i.venue = 'gemini-exchange'
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'research' AND tablename = 'quote_snapshots' AND policyname = 'worker_write_quotes_insert'
  ) THEN
    CREATE POLICY worker_write_quotes_insert ON research.quote_snapshots
      FOR INSERT TO verity_history_writer WITH CHECK (source_mode = 'live');
  END IF;
END
$$;

-- Gives the existing Hyperdrive login the writer role, in addition to the reader role.
-- supabase/worker-history-membership.sql allows this membership and no others.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'verity_history_worker' AND rolcanlogin
  ) THEN
    GRANT verity_history_writer TO verity_history_worker WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
  END IF;
END
$$;

COMMIT;
