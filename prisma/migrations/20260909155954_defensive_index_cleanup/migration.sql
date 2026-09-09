-- Defensive, idempotent re-issue of the two DROP INDEX statements from
-- 20260908111632_recurring_tasks. That migration dropped these without
-- IF EXISTS; if a previous partial/failed deploy ever left the DB in a
-- state where they'd already been removed (or never created — e.g. if
-- 20260908103854_phase0_stabilize's `CREATE EXTENSION pg_trgm` was ever
-- rejected on a database with fewer privileges), the earlier DROP would
-- error and leave Prisma's migration history in a "failed" state that
-- blocks every subsequent `migrate deploy` (P3009) until resolved.
--
-- This is a pure no-op in the normal case (the indexes are already gone).
-- Never edit an already-applied migration file to add IF EXISTS after the
-- fact — Prisma checksums each one; a new corrective migration is the
-- correct fix.
DROP INDEX IF EXISTS "Page_title_trgm_idx";
DROP INDEX IF EXISTS "Task_title_trgm_idx";
