-- Owner-applied grants for scheduled quote collection.
-- Do not run this from CI, from the Worker, or against a database until the
-- owner has reviewed it. It does not create indexes. Production already has a
-- unique key on research.instruments (venue, external_instrument_id) and on
-- research.quote_snapshots (instrument_id, source_mode, observed_at). The
-- Worker's ON CONFLICT clauses use those keys.
-- The read-only verity_history_reader role is unchanged.
--
-- The Worker login keeps working as a reader if this file is not applied.
-- Collection then fails, is logged once, and does not change market responses.
-- Both id columns are identity columns, so this role gets no sequence grants.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verity_history_writer') THEN
    CREATE ROLE verity_history_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA research TO verity_history_writer;
GRANT SELECT, INSERT ON research.instruments, research.quote_snapshots TO verity_history_writer;

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
      FOR INSERT TO verity_history_writer WITH CHECK (
        source_mode = 'live' AND EXISTS (
          SELECT 1 FROM research.instruments i
          WHERE i.id = quote_snapshots.instrument_id AND i.venue = 'gemini-exchange'
        )
      );
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
