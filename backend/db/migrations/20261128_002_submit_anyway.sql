BEGIN;
SET LOCAL lock_timeout = '5s';

-- Defaults preserve the original pass-required intent of all existing rows.
ALTER TABLE public.submission_requests ADD COLUMN submit_anyway BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.submissions
  ADD COLUMN submit_anyway BOOLEAN NOT NULL DEFAULT false,
  DROP CONSTRAINT submissions_final_valid,
  ADD CONSTRAINT submissions_final_valid CHECK (
    (kind = 'practice' AND request_id IS NULL AND version IS NULL AND code_sha256 IS NULL AND NOT submit_anyway)
    OR (kind = 'final' AND request_id IS NOT NULL AND version IS NOT NULL AND version > 0
      AND code_sha256 IS NOT NULL AND code_sha256 ~ '^[0-9a-f]{64}$'
      AND jsonb_array_length(results) = total
      AND ((submit_anyway AND (status <> 'ok' OR total > 0))
        OR (status = 'ok' AND total > 0 AND passed = total AND score = 100)))
  );
COMMENT ON COLUMN public.submissions.submit_anyway IS
  'Student explicitly chose to submit even if tests fail. The execution score is not a teacher-awarded grade.';
COMMENT ON COLUMN public.labs.max_submissions IS
  'Maximum stored final submissions per student, including pass-required and submit-anyway work; NULL is unlimited. Practice and rejected requests do not count.';

CREATE OR REPLACE FUNCTION public.guard_final_submission() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  submission_limit INTEGER;
  accepted_count BIGINT;
BEGIN
  IF NEW.kind = 'practice' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.student_id::text || ':' || NEW.lab_id::text, 0));
  SELECT max_submissions INTO submission_limit FROM public.labs WHERE id = NEW.lab_id FOR SHARE;
  SELECT count(*), COALESCE(max(version), 0) + 1 INTO accepted_count, NEW.version
    FROM public.submissions WHERE lab_id = NEW.lab_id AND student_id = NEW.student_id AND kind = 'final';
  IF submission_limit IS NOT NULL AND accepted_count >= submission_limit THEN
    IF submission_limit = 1 THEN
      RAISE EXCEPTION 'Final submission is locked' USING ERRCODE = '23514', CONSTRAINT = 'final_submission_locked';
    END IF;
    RAISE EXCEPTION 'Accepted submission limit reached' USING ERRCODE = '23514', CONSTRAINT = 'final_submission_limit_reached';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.submission_requests
    WHERE id = NEW.request_id AND lab_id = NEW.lab_id AND student_id = NEW.student_id
      AND code = NEW.code AND submit_anyway = NEW.submit_anyway
  ) THEN
    RAISE EXCEPTION 'Final source and submission mode must match their request' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
