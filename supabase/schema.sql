-- Drop the next_auth schema approach entirely.
-- Simpler flat schema: users table holds everything including OAuth tokens.

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  image text,
  access_token text,
  refresh_token text,
  expires_at bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  goal_id uuid references public.goals(id) on delete set null,
  title text not null,
  description text,
  priority text not null check (priority in ('high', 'medium', 'low')) default 'medium',
  status text not null check (status in ('todo', 'in-progress', 'done')) default 'todo',
  deadline date,
  source text not null check (source in ('manual', 'gmail')) default 'manual',
  gmail_thread_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  gmail_message_id text not null,
  thread_id text not null,
  subject text not null,
  from_email text not null,
  body_snippet text not null default '',
  received_at timestamptz not null,
  processed boolean not null default false,
  extracted_task_id uuid references public.tasks(id) on delete set null,
  unique (user_id, gmail_message_id)
);

create table if not exists public.robin_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  action jsonb,
  created_at timestamptz not null default now()
);
