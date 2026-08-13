-- CONFIDENCE PROVENANCE. The calibration ledger asks one question: did the
-- confidence this company STATED predict the outcome it later observed?
--
-- The extractor was answering that question with numbers nobody stated. When a
-- markets answer expressed no conviction, it silently wrote 0.6 — and that
-- invented number was then allocated against, resolved against real prices, and
-- graded as if an analyst had committed to it. Seven of the first forty
-- resolved rows sat at exactly 0.60.
--
-- The extractor now omits confidence rather than guessing, and this column
-- records which is which, so the ledger can separate a conviction from a
-- placeholder instead of averaging them together.
--
-- Default TRUE, deliberately: rows written before this migration came from the
-- old extractor and cannot be re-attributed, so they keep behaving exactly as
-- they did rather than being silently reclassified as placeholders.
--
-- Run inside the Supabase SQL Editor or via `supabase db push`. Idempotent.

alter table predictions add column if not exists confidence_stated boolean not null default true;

comment on column predictions.confidence_stated is
  'False when the extractor supplied a default because the answer expressed no conviction. Calibration reads this to tell a stated conviction from a placeholder.';
