BEGIN;
SET LOCAL lock_timeout = '5s';

-- NULL pairs explicitly identify labs uploaded before validation was added.
ALTER TABLE public.labs
  ADD COLUMN validated_at TIMESTAMPTZ,
  ADD COLUMN validation_summary JSONB,
  ADD CONSTRAINT labs_validation_audit_valid CHECK (
    (validated_at IS NULL AND validation_summary IS NULL)
    OR (validated_at IS NOT NULL AND validation_summary IS NOT NULL AND (
      jsonb_typeof(validation_summary) = 'object'
      AND validation_summary->>'valid' = 'true'
      AND validation_summary->>'status' = 'ok'
      AND jsonb_typeof(validation_summary->'total_tests') = 'number'
      AND (validation_summary->>'total_tests')::numeric >= 1
      AND validation_summary->'passed_tests' = validation_summary->'total_tests'
      AND jsonb_typeof(validation_summary->'warnings') = 'array'
    ) IS TRUE)
  );
COMMENT ON COLUMN public.labs.validated_at IS
  'Server time when a successfully pre-tested lab was saved; NULL means not validated by the upload workflow.';
COMMENT ON COLUMN public.labs.validation_summary IS
  'Teacher-only validation audit summary. Never expose to student APIs; warnings may contain hidden-test labels.';

COMMIT;
