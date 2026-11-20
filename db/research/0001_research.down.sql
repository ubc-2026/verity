-- Verity research store, migration 0001 (rollback).
--
-- This deletes every research record. Back up first:
--   pg_dump --schema=research --format=custom --file=research-0001.dump "$OWNER_URL"
-- It leaves the payment stores (SQLite) alone.
--
-- Drop the login roles that are members of the group roles first if they are
-- no longer needed; dropping a group role removes those memberships.

drop schema if exists research cascade;

-- Roles are shared by every database on the server. A role that still holds
-- privileges in another database is kept, with a notice, instead of failing
-- the rollback.
do $$
declare
  r text;
begin
  foreach r in array array['verity_research_reader', 'verity_research_ingest'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      begin
        execute format('drop role %I', r);
      exception when dependent_objects_still_exist then
        raise notice 'kept role %: it still holds privileges in another database', r;
      end;
    end if;
  end loop;
end
$$;
