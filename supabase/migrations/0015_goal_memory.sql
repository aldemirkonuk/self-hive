-- SELFHIVE INSTITUTIONAL MEMORY (Phase 1.2). Migration 0013 gave the hive an
-- agenda that spans runs. It did not give it a MEMORY of that agenda: the
-- moment a goal was closed it vanished from the Chief of Staff's prompt
-- entirely, and the reason it was closed lived only in the change_requests
-- audit row — reachable by the founder, never by an agent.
--
-- The practical failure that caused: the hive would abandon a goal on Monday
-- and, seeing the same scouted gap on Tuesday, propose it again word for word.
-- An employee who forgets every decision the moment it is made is not learning;
-- they are looping. These two columns are what a closed goal leaves behind.
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. Idempotent.

-- WHEN a goal stopped being active. Distinct from updated_at, which any future
-- edit would move — the reopen cooldown in lib/goals/core.ts needs a timestamp
-- that means "closed", and only that.
alter table hive_goals add column if not exists closed_at timestamptz;

-- WHY it was closed, in the closer's own words. This is the sentence that gets
-- fed back to the Chief of Staff as the goal's lesson, so it is part of the
-- prompt surface, not just an audit field.
alter table hive_goals add column if not exists closure_note text;

-- Rows closed before this migration have no closed_at. Backfill from
-- updated_at, which closeGoal() has always stamped at close time — without it,
-- the cooldown would treat every historical closure as having happened at the
-- epoch and let the hive immediately re-propose goals it already settled.
update hive_goals
   set closed_at = updated_at
 where status <> 'active' and closed_at is null;

-- The Chief of Staff reads the most recently closed goals on every run, so this
-- ordering is a hot path, not a reporting convenience.
create index if not exists hive_goals_user_closed_idx
  on hive_goals(user_id, closed_at desc)
  where status <> 'active';
