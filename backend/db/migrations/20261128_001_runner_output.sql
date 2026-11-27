BEGIN;
SET LOCAL lock_timeout = '5s';

-- Older executions cannot recover diagnostics that were previously discarded.
-- Leave them NULL instead of fabricating stdout, timing, or traceback data.
ALTER TABLE public.submissions
  ADD COLUMN execution_output JSON,
  ADD CONSTRAINT submissions_execution_output_object CHECK (
    execution_output IS NULL OR json_typeof(execution_output) = 'object'
  );
COMMENT ON COLUMN public.submissions.execution_output IS
  'Complete validated student-view runner response plus legacy results. NULL for older records. May include test inputs, answers, stdout and diagnostics.';

-- Console output can contain escaped NUL characters. PostgreSQL JSON preserves
-- them, whereas JSONB rejects them. Replay must preserve the same output too.
-- Avoid JSON field-extraction checks here: PostgreSQL also decodes escapes in
-- those operators. The runner adapter validates fields/counts before saving;
-- existing typed columns and final-validity constraints remain authoritative.
ALTER TABLE public.submission_outcomes
  DROP CONSTRAINT submission_outcomes_body_check,
  ALTER COLUMN body TYPE JSON USING body::json,
  ADD CONSTRAINT submission_outcomes_body_check CHECK (json_typeof(body) = 'object');

COMMIT;
