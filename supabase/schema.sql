-- =========================================================================
-- Budget 2026 — Supabase schema
--
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> paste
-- -> Run. It is idempotent, so re-running it is safe.
--
-- Design: the app's data is one JSON document, so that is exactly what we
-- store. A row per (user, doc_key) holding JSONB. This keeps the migration
-- from the local-file version trivial and means the app logic is unchanged.
-- The `revision` column gives us optimistic concurrency so two devices
-- can't silently overwrite each other.
-- =========================================================================

create table if not exists public.budget_documents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  doc_key     text not null default 'budget-2026',
  doc         jsonb not null default '{}'::jsonb,
  revision    bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint budget_documents_user_doc_unique unique (user_id, doc_key)
);

comment on table  public.budget_documents is 'One budget document per user per doc_key. `doc` is the whole app state.';
comment on column public.budget_documents.revision is 'Incremented on every write; used for optimistic concurrency from the client.';

-- Look-ups are always by (user_id, doc_key); the unique constraint already
-- provides that index, so no extra index is needed.

-- ---------------------------------------------------------------- RLS ---
-- Without this, the public anon key would expose everyone's data. With it,
-- a signed-in user can only ever see and change their own row.

alter table public.budget_documents enable row level security;

drop policy if exists "own document: select" on public.budget_documents;
create policy "own document: select"
  on public.budget_documents for select
  using (auth.uid() = user_id);

drop policy if exists "own document: insert" on public.budget_documents;
create policy "own document: insert"
  on public.budget_documents for insert
  with check (auth.uid() = user_id);

drop policy if exists "own document: update" on public.budget_documents;
create policy "own document: update"
  on public.budget_documents for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own document: delete" on public.budget_documents;
create policy "own document: delete"
  on public.budget_documents for delete
  using (auth.uid() = user_id);

-- ------------------------------------------------------- write guards ---
-- The client sends revision = previous + 1 and filters on the previous
-- value, but belt and braces: never let a write go backwards, and always
-- stamp updated_at server-side so clock skew between devices can't matter.

create or replace function public.budget_documents_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.user_id    := old.user_id;            -- a row can't change owner
  if new.revision <= old.revision then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists budget_documents_touch on public.budget_documents;
create trigger budget_documents_touch
  before update on public.budget_documents
  for each row execute function public.budget_documents_touch();

-- ---------------------------------------------------------- realtime ----
-- Lets a phone pick up an edit made on the desktop without a refresh.
-- Safe to fail if the publication already includes the table.

do $$
begin
  alter publication supabase_realtime add table public.budget_documents;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

-- REPLICA IDENTITY FULL so the realtime payload carries the whole row
-- (we read `doc` straight out of it).
alter table public.budget_documents replica identity full;

-- ------------------------------------------------------- daily backup ---
-- Optional but strongly recommended: a cheap version history, so a bad
-- import or a mis-click is recoverable.

create table if not exists public.budget_document_versions (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  doc_key     text not null,
  revision    bigint not null,
  doc         jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.budget_document_versions enable row level security;

drop policy if exists "own versions: select" on public.budget_document_versions;
create policy "own versions: select"
  on public.budget_document_versions for select
  using (auth.uid() = user_id);

drop policy if exists "own versions: insert" on public.budget_document_versions;
create policy "own versions: insert"
  on public.budget_document_versions for insert
  with check (auth.uid() = user_id);

create index if not exists budget_document_versions_lookup
  on public.budget_document_versions (user_id, doc_key, created_at desc);

-- Keep at most one snapshot per user/doc per day, and only the last 60.
create or replace function public.budget_documents_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.budget_document_versions v
    where v.user_id = new.user_id
      and v.doc_key = new.doc_key
      and v.created_at > now() - interval '1 day'
  ) then
    return new;
  end if;

  insert into public.budget_document_versions (user_id, doc_key, revision, doc)
  values (new.user_id, new.doc_key, new.revision, new.doc);

  delete from public.budget_document_versions
  where id in (
    select id from public.budget_document_versions
    where user_id = new.user_id and doc_key = new.doc_key
    order by created_at desc
    offset 60
  );

  return new;
end;
$$;

drop trigger if exists budget_documents_snapshot on public.budget_documents;
create trigger budget_documents_snapshot
  after update on public.budget_documents
  for each row execute function public.budget_documents_snapshot();
