-- GitHub signups for verityresearch.us.
--
-- GitHub has no ID token that can be checked before Supabase creates the account, so the Google proof
-- (a hash of the verified Google subject) cannot be used. Instead:
--
-- 1. POST /auth/start with provider "github" passes the Turnstile check and returns a sealed ticket that is
--    valid for 2 minutes.
-- 2. The browser opens consumer-auth/github on the Supabase origin. The Edge Function checks the ticket and
--    stores one proof: a hash of the ticket (so the ticket works once) and a hash of the client address that
--    the Supabase gateway reports.
-- 3. When GitHub returns, Supabase Auth calls app_private.before_google_signup. A new GitHub user is allowed
--    only with a verified email and an unused, unexpired proof for the same client address, which the hook
--    marks as used.
--
-- Addresses are stored only as SHA-256 hashes of the canonical inet text, and rows are deleted 10 minutes
-- after they are written.

CREATE TABLE IF NOT EXISTS app_private.github_signup_proofs (
  ticket_hash bytea PRIMARY KEY,
  ip_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS github_signup_proofs_open
  ON app_private.github_signup_proofs (ip_hash, expires_at) WHERE consumed_at IS NULL;

ALTER TABLE app_private.github_signup_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.github_signup_proofs FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON app_private.github_signup_proofs TO supabase_auth_admin;

DROP POLICY IF EXISTS github_signup_proof_read ON app_private.github_signup_proofs;
CREATE POLICY github_signup_proof_read ON app_private.github_signup_proofs
  FOR SELECT TO supabase_auth_admin USING (true);
DROP POLICY IF EXISTS github_signup_proof_consume ON app_private.github_signup_proofs;
CREATE POLICY github_signup_proof_consume ON app_private.github_signup_proofs
  FOR UPDATE TO supabase_auth_admin USING (consumed_at IS NULL) WITH CHECK (consumed_at IS NOT NULL);

-- Returns the SHA-256 of the canonical text of an address, or NULL when the value is not an address.
CREATE OR REPLACE FUNCTION app_private.signup_address_hash(address text)
  RETURNS bytea
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
AS $function$
BEGIN
  IF address IS NULL OR length(address) > 45 OR address !~ '^[0-9A-Fa-f:.]+$' THEN RETURN NULL; END IF;
  RETURN sha256(convert_to(host(address::inet), 'UTF8'));
EXCEPTION WHEN others THEN
  RETURN NULL;
END; $function$;
REVOKE ALL ON FUNCTION app_private.signup_address_hash(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.signup_address_hash(text) TO supabase_auth_admin;

-- The hook keeps its name so the Authentication > Hooks setting does not change.
CREATE OR REPLACE FUNCTION app_private.before_google_signup(event jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path TO ''
AS $function$
DECLARE
  provider text := event #>> '{user,app_metadata,provider}';
  google_subject text := event #>> '{user,user_metadata,sub}';
  address_hash bytea;
BEGIN
  IF provider = 'google'
    AND event #>> '{user,user_metadata,iss}' IN ('https://accounts.google.com', 'accounts.google.com')
    AND event #> '{user,user_metadata,email_verified}' = 'true'::jsonb
    AND google_subject ~ '^[A-Za-z0-9_-]{1,255}$' THEN
    DELETE FROM app_private.google_signup_proofs
    WHERE subject_hash = sha256(convert_to(google_subject, 'UTF8')) AND expires_at > statement_timestamp();
    IF FOUND THEN RETURN '{}'::jsonb; END IF;
  ELSIF provider = 'github'
    AND event #>> '{user,user_metadata,iss}' = 'https://api.github.com'
    AND event #> '{user,user_metadata,email_verified}' = 'true'::jsonb THEN
    address_hash := app_private.signup_address_hash(event #>> '{metadata,ip_address}');
    IF address_hash IS NOT NULL THEN
      UPDATE app_private.github_signup_proofs SET consumed_at = statement_timestamp()
      WHERE ticket_hash = (
        SELECT ticket_hash FROM app_private.github_signup_proofs
        WHERE ip_hash = address_hash AND consumed_at IS NULL AND expires_at > statement_timestamp()
        ORDER BY expires_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      );
      IF FOUND THEN RETURN '{}'::jsonb; END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403,
    'message', 'Create your account from the Verity sign-in page.'));
END; $function$;
REVOKE ALL ON FUNCTION app_private.before_google_signup(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.before_google_signup(jsonb) TO supabase_auth_admin;
