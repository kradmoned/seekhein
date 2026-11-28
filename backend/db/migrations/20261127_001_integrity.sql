BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.integrity_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lab_id UUID NOT NULL REFERENCES public.labs(id),
  student_id UUID NOT NULL REFERENCES public.profiles(id),
  event_id UUID NOT NULL,
  session_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'lab_opened', 'paste_blocked', 'large_insert', 'tab_hidden',
    'tab_visible', 'window_blur', 'window_focus', 'run', 'chat_sent'
  )),
  payload JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  client_ts TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (lab_id, student_id, event_id)
);
CREATE INDEX integrity_events_lab_student_time_idx
  ON public.integrity_events (lab_id, student_id, received_at, id);

CREATE TABLE public.submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id UUID NOT NULL REFERENCES public.labs(id),
  student_id UUID NOT NULL REFERENCES public.profiles(id),
  code TEXT NOT NULL CHECK (octet_length(code) <= 65536),
  status TEXT NOT NULL CHECK (status IN ('ok', 'syntax_error', 'runtime_error', 'timeout', 'oom')),
  results JSONB NOT NULL CHECK (jsonb_typeof(results) = 'array'),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  passed INTEGER NOT NULL CHECK (passed >= 0),
  total INTEGER NOT NULL CHECK (total >= passed),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX submissions_lab_student_time_idx
  ON public.submissions (lab_id, student_id, created_at, id);

CREATE FUNCTION public.reject_activity_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Activity records are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER integrity_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.integrity_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_activity_mutation();
CREATE TRIGGER submissions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.submissions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_activity_mutation();

REVOKE ALL ON public.integrity_events, public.submissions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.integrity_events_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_activity_mutation() FROM PUBLIC, anon, authenticated;

COMMIT;
