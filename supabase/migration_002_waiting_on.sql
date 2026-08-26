-- ============================================================
-- Migration 002: waiting_on field for contingent tasks
-- Run in Supabase SQL Editor. ADDITIVE only — no existing
-- data is dropped or modified.
-- ============================================================

-- Adds a short free-text description of what external event
-- a task is waiting on (e.g. "design team sending final screens").
-- NULL means the task is immediately actionable.
-- Distinct from task_dependencies (which are task-to-task DB edges);
-- this captures real-world events outside the task system.
alter table public.tasks
  add column if not exists waiting_on text;
