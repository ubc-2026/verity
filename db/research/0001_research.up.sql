-- Verity research store, migration 0001 (up).
--
-- A private schema for market research history: instruments, quote snapshots,
-- versioned source documents, and append-only assessment versions.
--
-- Repeatable: every statement checks for what already exists, so a second run
-- changes nothing. Run it as the schema owner (the role that applies
-- migrations), never as the ingest or reader role.
--
-- It does not touch the payment, reservation, approval or settlement stores.
-- Those stay in SQLite, and neither research role gets any grant outside this
-- schema.

create schema if not exists research;
revoke all on schema research from public;

-- Group roles. They cannot log in. Login roles (one for the ingest server, one
-- for the read API) are created by the database owner outside git and granted
-- membership. See db/research/README.md.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'verity_research_ingest') then
    create role verity_research_ingest nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'verity_research_reader') then
    create role verity_research_reader nologin;
  end if;
end
$$;

create table if not exists research.schema_migrations (
  version text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

-- One row per tradable outcome, keyed by exchange and the exchange's own
-- identifiers: the event ticker and the outcome's instrument symbol.
create table if not exists research.instruments (
  id bigint generated always as identity primary key,
  exchange text not null check (exchange ~ '^[a-z][a-z0-9_-]{1,31}$'),
  instrument_id text not null check (instrument_id ~ '^[A-Za-z0-9._:-]{1,120}$'),
  outcome_id text not null check (outcome_id ~ '^[A-Za-z0-9._:-]{1,120}$'),
  question text not null check (length(question) between 1 and 500),
  outcome_label text not null check (length(outcome_label) between 1 and 200),
  category text not null check (category in ('weather', 'sports', 'economics', 'other')),
  expiry_utc timestamptz,
  settlement_source text check (length(settlement_source) <= 500),
  terms_url text check (terms_url ~ '^https://[^\s]+$' and length(terms_url) <= 500),
  data_label text not null check (data_label in ('FIXTURE', 'CAPTURED', 'LIVE')),
  created_at timestamptz not null default now(),
  constraint instruments_key unique (exchange, instrument_id, outcome_id)
);

-- Other names for the same outcome: Verity's fixture contract ID, the venue's
-- numeric contract ID.
create table if not exists research.instrument_aliases (
  alias text primary key check (alias ~ '^[A-Za-z0-9._:-]{1,120}$'),
  instrument_ref bigint not null references research.instruments (id),
  alias_kind text not null check (alias_kind in ('verity_contract_id', 'venue_contract_id', 'other')),
  created_at timestamptz not null default now()
);

-- One row per observation of the book. Stale is not stored: it depends on when
-- the row is read, so the API works it out from captured_at.
create table if not exists research.quote_snapshots (
  id bigint generated always as identity primary key,
  instrument_ref bigint not null references research.instruments (id),
  source_identity text not null check (source_identity ~ '^sha256:[0-9a-f]{64}$'),
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  data_label text not null check (data_label in ('FIXTURE', 'CAPTURED', 'LIVE')),
  venue_ts timestamptz,
  captured_at timestamptz,
  captured_date date,
  best_bid numeric(6, 4) check (best_bid between 0 and 1),
  best_ask numeric(6, 4) check (best_ask between 0 and 1),
  last_trade numeric(6, 4) check (last_trade between 0 and 1),
  market_state text not null check (market_state in ('open', 'closed', 'settled', 'unknown')),
  quote_state text not null check (quote_state in
    ('two_sided', 'one_sided_bid', 'one_sided_ask', 'missing', 'crossed', 'closed', 'unavailable')),
  implied_probability numeric(6, 4),
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  ingested_at timestamptz not null default now(),
  constraint quote_snapshots_identity unique (source_identity),
  constraint quote_has_time check (captured_at is not null or captured_date is not null),
  constraint quote_state_matches_book check (
    case quote_state
      when 'two_sided' then best_bid is not null and best_ask is not null and best_bid <= best_ask and market_state = 'open'
      when 'crossed' then best_bid is not null and best_ask is not null and best_bid > best_ask
      when 'one_sided_bid' then best_bid is not null and best_ask is null
      when 'one_sided_ask' then best_bid is null and best_ask is not null
      when 'missing' then best_bid is null and best_ask is null
      when 'closed' then market_state in ('closed', 'settled')
      when 'unavailable' then best_bid is null and best_ask is null
    end),
  -- The market-implied probability is the mid of a two-sided, uncrossed book.
  -- Every other state stores no implied probability.
  constraint implied_only_from_two_sided check (
    (quote_state = 'two_sided') = (implied_probability is not null)
    and (implied_probability is null or implied_probability = round((best_bid + best_ask) / 2, 4)))
);
create index if not exists quote_snapshots_by_instrument
  on research.quote_snapshots (instrument_ref, captured_at, captured_date);

-- Versioned documents: rules text, venue records, official data, purchased
-- evidence. A new version is added only when the content hash changes, so
-- replaying the same document adds nothing.
create table if not exists research.source_documents (
  id bigint generated always as identity primary key,
  instrument_ref bigint references research.instruments (id),
  source_key text not null check (source_key ~ '^[a-z][a-z0-9-]*(:[A-Za-z0-9._-]{1,120}){1,6}$'),
  version integer not null check (version >= 1),
  kind text not null check (kind in ('rules', 'venue_record', 'official_data', 'evidence', 'free_check')),
  data_label text not null check (data_label in ('FIXTURE', 'CAPTURED', 'LIVE')),
  media_type text not null check (media_type in ('text/plain', 'application/json')),
  content text not null check (length(content) <= 200000),
  content_sha256 text not null check (content_sha256 ~ '^0x[0-9a-f]{64}$'),
  retrieved_at timestamptz,
  retrieved_date date,
  verification_status text not null check (verification_status in ('not_required', 'unverified', 'verified', 'rejected')),
  verification jsonb not null default '{}'::jsonb check (jsonb_typeof(verification) = 'object'),
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  ingested_at timestamptz not null default now(),
  constraint source_documents_version unique (source_key, version),
  constraint source_documents_identity unique (source_key, content_sha256),
  constraint source_has_time check (retrieved_at is not null or retrieved_date is not null),
  constraint evidence_is_checked check (kind <> 'evidence' or verification_status <> 'not_required')
);

-- Assessment versions. The first is the original; each reassessment points at
-- its parent and adds one to seq. Rows are never edited.
create table if not exists research.assessments (
  id bigint generated always as identity primary key,
  instrument_ref bigint not null references research.instruments (id),
  assessment_key text not null check (assessment_key ~ '^sha256:[0-9a-f]{64}$'),
  parent_id bigint references research.assessments (id),
  seq integer not null check (seq >= 1),
  schema_version text not null check (length(schema_version) between 1 and 80),
  rubric_version text not null check (length(rubric_version) between 1 and 80),
  analyst_id text not null check (length(analyst_id) between 1 and 80),
  data_label text not null check (data_label in ('FIXTURE', 'CAPTURED', 'LIVE')),
  assessed_at timestamptz not null,
  quote_snapshot_id bigint references research.quote_snapshots (id),
  rating jsonb not null check (jsonb_typeof(rating) = 'object'),
  scores jsonb not null check (jsonb_typeof(scores) = 'object'),
  cited_claims jsonb not null check (jsonb_typeof(cited_claims) = 'array'),
  evidence_gap jsonb check (evidence_gap is null or jsonb_typeof(evidence_gap) = 'object'),
  decision text not null check (decision in ('buy', 'abstain', 'revised', 'unchanged', 'evidence_rejected')),
  decision_reason text not null check (length(decision_reason) between 1 and 4000),
  trigger_source_id bigint references research.source_documents (id),
  changes jsonb not null default '[]'::jsonb check (jsonb_typeof(changes) = 'array'),
  ingested_at timestamptz not null default now(),
  constraint assessments_identity unique (assessment_key),
  constraint assessments_seq unique (instrument_ref, seq),
  constraint assessments_lineage check ((parent_id is null) = (seq = 1)),
  constraint reassessment_has_trigger check (parent_id is null or trigger_source_id is not null),
  constraint original_decides check (parent_id is not null or decision in ('buy', 'abstain')),
  constraint reassessment_decides check (parent_id is null or decision in ('revised', 'unchanged', 'evidence_rejected'))
);

-- Which source versions an assessment read.
create table if not exists research.assessment_sources (
  assessment_id bigint not null references research.assessments (id),
  source_document_id bigint not null references research.source_documents (id),
  role text not null check (role in ('rules', 'venue_record', 'official_data', 'evidence', 'free_check')),
  primary key (assessment_id, source_document_id)
);

-- Append-only: no role may edit or delete a research record.
create or replace function research.forbid_mutation() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'research records are append-only (% on %)', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end
$$;

-- Source documents: check the hash and assign the next version for the key.
create or replace function research.prepare_source_document() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if new.content_sha256 <> '0x' || encode(sha256(convert_to(new.content, 'UTF8')), 'hex') then
    raise exception 'content_sha256 does not match the content' using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('research.source_documents:' || new.source_key, 0));
  if exists (select 1 from research.source_documents d
             where d.source_key = new.source_key and d.instrument_ref is distinct from new.instrument_ref) then
    raise exception 'source key % already belongs to another instrument', new.source_key using errcode = 'check_violation';
  end if;
  select coalesce(max(d.version), 0) + 1 into new.version
    from research.source_documents d where d.source_key = new.source_key;
  return new;
end
$$;

-- Assessments: a reassessment extends the latest version of the same
-- instrument, and a changed finding must trace to verified evidence.
create or replace function research.prepare_assessment() returns trigger
language plpgsql set search_path = pg_catalog as $$
declare
  parent research.assessments%rowtype;
  latest integer;
  trig research.source_documents%rowtype;
  any_change boolean;
begin
  -- A replay of a stored assessment is skipped here, before the lineage checks.
  if exists (select 1 from research.assessments a where a.assessment_key = new.assessment_key) then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('research.assessments:' || new.instrument_ref::text, 0));
  select coalesce(max(a.seq), 0) into latest from research.assessments a where a.instrument_ref = new.instrument_ref;
  if new.parent_id is null then
    if latest > 0 then
      raise exception 'instrument already has an original assessment; append a reassessment instead'
        using errcode = 'check_violation';
    end if;
    new.seq := 1;
    return new;
  end if;
  select * into parent from research.assessments a where a.id = new.parent_id;
  if not found or parent.instrument_ref <> new.instrument_ref then
    raise exception 'parent assessment belongs to another instrument' using errcode = 'check_violation';
  end if;
  if parent.seq <> latest then
    raise exception 'reassessment must extend the latest assessment (seq %)', latest using errcode = 'check_violation';
  end if;
  new.seq := parent.seq + 1;
  select * into trig from research.source_documents d where d.id = new.trigger_source_id;
  if not found or trig.instrument_ref is distinct from new.instrument_ref or trig.kind <> 'evidence' then
    raise exception 'reassessment trigger must be an evidence document for this instrument' using errcode = 'check_violation';
  end if;
  select coalesce(bool_or((c ->> 'changed')::boolean), false) into any_change from jsonb_array_elements(new.changes) c;
  if (any_change or new.decision = 'revised' or new.rating <> parent.rating or new.scores <> parent.scores)
     and trig.verification_status <> 'verified' then
    raise exception 'a changed finding needs verified evidence (trigger is %)', trig.verification_status
      using errcode = 'check_violation';
  end if;
  if new.decision = 'revised' and not any_change then
    raise exception 'a revised assessment must list the finding that changed' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array['instruments', 'instrument_aliases', 'quote_snapshots', 'source_documents', 'assessments', 'assessment_sources'] loop
    execute format('drop trigger if exists %I on research.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on research.%I for each row execute function research.forbid_mutation()', t || '_append_only', t);
    execute format('drop trigger if exists %I on research.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on research.%I for each statement execute function research.forbid_mutation()', t || '_no_truncate', t);
    execute format('alter table research.%I enable row level security', t);
    execute format('drop policy if exists ingest_read on research.%I', t);
    execute format('create policy ingest_read on research.%I for select to verity_research_ingest using (true)', t);
    execute format('drop policy if exists ingest_append on research.%I', t);
    execute format('create policy ingest_append on research.%I for insert to verity_research_ingest with check (true)', t);
  end loop;
end
$$;
drop trigger if exists source_documents_prepare on research.source_documents;
create trigger source_documents_prepare before insert on research.source_documents
  for each row execute function research.prepare_source_document();
drop trigger if exists assessments_prepare on research.assessments;
create trigger assessments_prepare before insert on research.assessments
  for each row execute function research.prepare_assessment();

-- Display views: the only objects the reader role can select. They leave out
-- provenance, verification details (receipt digest, signer, purchase and
-- request IDs) and the bytes of purchased evidence.
create or replace view research.instrument_display as
  select i.exchange, i.instrument_id, i.outcome_id, i.question, i.outcome_label, i.category,
         i.expiry_utc, i.settlement_source, i.terms_url, i.data_label
  from research.instruments i;

create or replace view research.alias_display as
  select a.alias, a.alias_kind, i.exchange, i.instrument_id, i.outcome_id
  from research.instrument_aliases a
  join research.instruments i on i.id = a.instrument_ref;

create or replace view research.quote_display as
  select i.exchange, i.instrument_id, i.outcome_id, q.id as snapshot_id, q.provider, q.data_label,
         q.venue_ts, q.captured_at, q.captured_date, q.best_bid, q.best_ask, q.last_trade,
         q.market_state, q.quote_state, q.implied_probability
  from research.quote_snapshots q
  join research.instruments i on i.id = q.instrument_ref;

create or replace view research.source_display as
  select i.exchange, i.instrument_id, i.outcome_id, d.id as source_id, d.source_key, d.version, d.kind,
         d.data_label, d.content_sha256, d.retrieved_at, d.retrieved_date, d.verification_status,
         case when d.kind = 'evidence' then null else d.content end as public_text
  from research.source_documents d
  join research.instruments i on i.id = d.instrument_ref;

create or replace view research.assessment_display as
  select i.exchange, i.instrument_id, i.outcome_id, a.id as assessment_id, a.seq, p.seq as parent_seq,
         a.schema_version, a.rubric_version, a.analyst_id, a.data_label, a.assessed_at, a.quote_snapshot_id,
         a.rating, a.scores, a.cited_claims, a.evidence_gap, a.decision, a.decision_reason, a.changes,
         t.source_key as trigger_source_key, t.version as trigger_source_version, t.kind as trigger_kind,
         t.verification_status as trigger_verification, t.content_sha256 as trigger_content_sha256,
         (select coalesce(jsonb_agg(jsonb_build_object('source_key', d.source_key, 'version', d.version, 'role', s.role)
                                    order by d.source_key, d.version), '[]'::jsonb)
            from research.assessment_sources s
            join research.source_documents d on d.id = s.source_document_id
           where s.assessment_id = a.id) as source_versions
  from research.assessments a
  join research.instruments i on i.id = a.instrument_ref
  left join research.assessments p on p.id = a.parent_id
  left join research.source_documents t on t.id = a.trigger_source_id;

-- Grants. Nothing for PUBLIC. The ingest role reads and appends base tables;
-- the reader role selects the display views only.
revoke all on all tables in schema research from public;
revoke all on all functions in schema research from public;
alter default privileges in schema research revoke all on tables from public;
alter default privileges in schema research revoke execute on functions from public;
grant usage on schema research to verity_research_ingest, verity_research_reader;
grant select, insert on research.instruments, research.instrument_aliases, research.quote_snapshots,
  research.source_documents, research.assessments, research.assessment_sources to verity_research_ingest;
grant select on research.instrument_display, research.alias_display, research.quote_display, research.source_display,
  research.assessment_display to verity_research_reader;

-- Supabase API roles get nothing here. The research schema must also stay out
-- of the Data API's exposed schemas (see db/research/README.md).
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema research from %I', r);
      execute format('revoke all on all tables in schema research from %I', r);
      execute format('revoke all on all functions in schema research from %I', r);
    end if;
  end loop;
end
$$;
