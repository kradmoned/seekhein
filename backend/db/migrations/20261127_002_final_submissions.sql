BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.labs ADD COLUMN allow_resubmissions BOOLEAN NOT NULL DEFAULT false;

-- Bind a key to exact source before execution. Bindings and outcomes survive
-- response loss; unfinished bindings can safely be executed again on retry.
CREATE TABLE public.submission_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id UUID NOT NULL REFERENCES public.labs(id),
  student_id UUID NOT NULL REFERENCES public.profiles(id),
  idempotency_key UUID NOT NULL,
  code TEXT NOT NULL CHECK (octet_length(code) <= 65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (lab_id, student_id, idempotency_key),
  UNIQUE (id, lab_id, student_id)
);

ALTER TABLE public.submissions
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'practice' CHECK (kind IN ('practice', 'final')),
  ADD COLUMN request_id UUID UNIQUE,
  ADD COLUMN version INTEGER,
  ADD COLUMN code_sha256 TEXT,
  ADD CONSTRAINT submissions_request_identity_fkey
    FOREIGN KEY (request_id, lab_id, student_id)
    REFERENCES public.submission_requests (id, lab_id, student_id),
  ADD CONSTRAINT submissions_final_valid CHECK (
    (kind = 'practice' AND request_id IS NULL AND version IS NULL AND code_sha256 IS NULL)
    OR (kind = 'final' AND request_id IS NOT NULL AND version IS NOT NULL AND version > 0
      AND code_sha256 IS NOT NULL AND code_sha256 ~ '^[0-9a-f]{64}$'
      AND status = 'ok' AND total > 0 AND passed = total AND score = 100
      AND jsonb_array_length(results) = total)
  );
CREATE UNIQUE INDEX submissions_final_version_idx
  ON public.submissions (lab_id, student_id, version) WHERE kind = 'final';

CREATE TABLE public.submission_outcomes (
  request_id UUID PRIMARY KEY REFERENCES public.submission_requests(id),
  http_status INTEGER NOT NULL CHECK (http_status IN (200, 409)),
  body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE FUNCTION public.guard_final_submission() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  resubmissions BOOLEAN;
BEGIN
  IF NEW.kind = 'practice' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.student_id::text || ':' || NEW.lab_id::text, 0));
  SELECT allow_resubmissions INTO resubmissions FROM public.labs WHERE id = NEW.lab_id FOR SHARE;
  IF NOT resubmissions AND EXISTS (
    SELECT 1 FROM public.submissions WHERE lab_id = NEW.lab_id AND student_id = NEW.student_id AND kind = 'final'
  ) THEN
    RAISE EXCEPTION 'Final submission is locked' USING ERRCODE = '23514', CONSTRAINT = 'final_submission_locked';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.submission_requests
    WHERE id = NEW.request_id AND lab_id = NEW.lab_id AND student_id = NEW.student_id AND code = NEW.code
  ) THEN
    RAISE EXCEPTION 'Final source must match its request' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO NEW.version FROM public.submissions
    WHERE lab_id = NEW.lab_id AND student_id = NEW.student_id AND kind = 'final';
  RETURN NEW;
END;
$$;
CREATE TRIGGER submissions_guard_final BEFORE INSERT ON public.submissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_final_submission();

CREATE TRIGGER submission_requests_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.submission_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_activity_mutation();
CREATE TRIGGER submission_outcomes_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.submission_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_activity_mutation();
REVOKE ALL ON public.submission_requests, public.submission_outcomes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_final_submission() FROM PUBLIC, anon, authenticated;
COMMIT;
