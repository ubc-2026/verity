-- Run after the owner saves the dedicated login with a generated password.
BEGIN;
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'verity_history_worker' AND rolcanlogin
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'A non-privileged verity_history_worker login is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles member ON member.oid = m.member
    JOIN pg_roles parent ON parent.oid = m.roleid
    WHERE member.rolname = 'verity_history_worker' AND parent.rolname <> 'verity_history_reader'
  ) THEN
    RAISE EXCEPTION 'The Worker login already has an unexpected role membership';
  END IF;
END
$check$;
GRANT verity_history_reader TO verity_history_worker WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
COMMIT;
