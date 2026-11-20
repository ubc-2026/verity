-- Apply to the project that already has the private Verity research schema.
-- This role cannot log in. A dedicated login may inherit it through a grant.
BEGIN;
CREATE ROLE verity_history_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA research TO verity_history_reader;
GRANT SELECT ON research.instruments, research.quote_snapshots TO verity_history_reader;
CREATE POLICY worker_read_instruments ON research.instruments
  FOR SELECT TO verity_history_reader USING (venue = 'gemini-exchange');
CREATE POLICY worker_read_live_quotes ON research.quote_snapshots
  FOR SELECT TO verity_history_reader USING (
    source_mode = 'live' AND EXISTS (
      SELECT 1 FROM research.instruments i
      WHERE i.id = quote_snapshots.instrument_id AND i.venue = 'gemini-exchange'
    )
  );
COMMIT;
