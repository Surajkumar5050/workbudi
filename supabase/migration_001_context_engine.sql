-- ============================================================
-- Migration 001: Robin Context-Aware Task Engine
-- Run in Supabase SQL Editor. All changes are ADDITIVE — no
-- existing data is dropped or modified.
-- ============================================================

-- 1. Full thread context instead of a single email snapshot.
--    Stores [{from, date, subject, body}] for every message in
--    the thread seen so far, oldest→newest, capped at 10 msgs.
alter table public.emails
  add column if not exists thread_context jsonb;

-- 2. Task dependency graph.
--    A task_id "depends on" depends_on_task_id — i.e. it is
--    blocked until depends_on_task_id has status 'done'.
create table if not exists public.task_dependencies (
  id                  uuid primary key default gen_random_uuid(),
  task_id             uuid not null references public.tasks(id) on delete cascade,
  depends_on_task_id  uuid not null references public.tasks(id) on delete cascade,
  created_at          timestamptz not null default now(),
  unique (task_id, depends_on_task_id)
);

-- 3. Allow 'cancelled' as a valid task status.
--    Drop the old constraint first, then re-add it with the
--    new value. Safe on live data because 'cancelled' is additive.
alter table public.tasks
  drop constraint if exists tasks_status_check;

alter table public.tasks
  add constraint tasks_status_check
  check (status in ('todo', 'in-progress', 'done', 'cancelled'));

-- 4. Confidence + provenance on extraction so the UI can show
--    "Robin guessed this" when confidence is low.
alter table public.tasks
  add column if not exists extraction_confidence numeric;

alter table public.tasks
  add column if not exists needs_review boolean not null default false;

-- 5. Clarification loop — where pending questions from Robin live.
--    The poll route writes here; the UI reads and PATCH-resolves.
create table if not exists public.clarifications (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  email_id            uuid references public.emails(id) on delete cascade,
  thread_id           text,
  question            text not null,
  -- context stores: candidate_tasks[], draft_extraction, thread_snippet, reasoning
  context             jsonb not null default '{}',
  status              text not null
                        check (status in ('pending', 'answered', 'dismissed'))
                        default 'pending',
  answer              text,
  resulting_task_id   uuid references public.tasks(id) on delete set null,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz
);

-- Index for fast pending-clarification lookup by user
create index if not exists clarifications_user_status_idx
  on public.clarifications (user_id, status);

-- 6. Promote goals to also represent "projects".
--    Existing rows default to 'goal' — no data change.
alter table public.goals
  add column if not exists kind text not null default 'goal'
  check (kind in ('goal', 'project'));

-- 7. Indexes for dependency lookups (task cards + Robin context build)
create index if not exists task_deps_task_id_idx
  on public.task_dependencies (task_id);

create index if not exists task_deps_depends_on_idx
  on public.task_dependencies (depends_on_task_id);
