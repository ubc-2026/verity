-- Supabase Before-User-Created hook (Authentication > Hooks), as deployed on 2026-11-20.
-- Grants: EXECUTE to supabase_auth_admin only. app_private.google_signup_proofs is written by
-- supabase/functions/consumer-auth (registration.ts) after a Turnstile check and a verified Google ID token.

CREATE OR REPLACE FUNCTION app_private.before_google_signup(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE google_subject text := event #>> '{user,user_metadata,sub}';
BEGIN
  IF event #>> '{user,app_metadata,provider}' = 'google'
    AND event #>> '{user,user_metadata,iss}' IN ('https://accounts.google.com', 'accounts.google.com')
    AND event #> '{user,user_metadata,email_verified}' = 'true'::jsonb
    AND google_subject ~ '^[A-Za-z0-9_-]{1,255}$' THEN
    DELETE FROM app_private.google_signup_proofs
    WHERE subject_hash = sha256(convert_to(google_subject, 'UTF8')) AND expires_at > statement_timestamp();
    IF FOUND THEN RETURN '{}'::jsonb; END IF;
  END IF;
  RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403,
    'message', 'Create your account from the Verity sign-in page.'));
END; $function$
;
