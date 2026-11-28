BEGIN;
SET LOCAL lock_timeout = '5s';

-- Counts accepted finals, including the first. NULL means unlimited.
ALTER TABLE public.labs ADD COLUMN max_submissions INTEGER DEFAULT 1
  CONSTRAINT labs_max_submissions_positive CHECK (max_submissions > 0);
UPDATE public.labs SET max_submissions = CASE WHEN allow_resubmissions THEN NULL ELSE 1 END;
ALTER TABLE public.labs ADD CONSTRAINT labs_submission_policy_consistent
  CHECK (allow_resubmissions = (max_submissions IS NULL OR max_submissions > 1));
COMMENT ON COLUMN public.labs.max_submissions IS
  'Maximum accepted final submissions per student, including the first; NULL is unlimited. Practice and failed executions do not count.';

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
    WHERE id = NEW.request_id AND lab_id = NEW.lab_id AND student_id = NEW.student_id AND code = NEW.code
  ) THEN
    RAISE EXCEPTION 'Final source must match its request' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
