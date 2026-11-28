BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.submissions ADD COLUMN tutor_output JSON,
  ADD CONSTRAINT submissions_tutor_output_object CHECK (tutor_output IS NULL OR json_typeof(tutor_output) = 'object');
COMMENT ON COLUMN public.submissions.tutor_output IS
  'Complete tutor view from the same execution as execution_output. Server-only; NULL for historical runs.';

CREATE TABLE public.chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id),
  lab_id UUID NOT NULL REFERENCES public.labs(id),
  next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, student_id)
);
CREATE INDEX chat_conversations_student_lab_idx ON public.chat_conversations(student_id, lab_id, created_at DESC, id DESC);

CREATE TABLE public.chat_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  student_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  idempotency_key UUID NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  attempt_id UUID REFERENCES public.submissions(id),
  -- JSON preserves escaped NULs in runner output; do not cast to JSONB.
  context_snapshot JSON NOT NULL CHECK (json_typeof(context_snapshot) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (conversation_id, student_id) REFERENCES public.chat_conversations(id, student_id),
  UNIQUE (conversation_id, idempotency_key),
  UNIQUE (conversation_id, sequence),
  UNIQUE (id, conversation_id),
  CHECK ((status = 'processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'processing' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX chat_one_processing_turn_idx ON public.chat_turns(conversation_id) WHERE status = 'processing';

CREATE TABLE public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id),
  turn_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(btrim(content)) > 0 AND octet_length(content) <= 32768),
  sources JSON NOT NULL DEFAULT '[]' CHECK (json_typeof(sources) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (turn_id, conversation_id) REFERENCES public.chat_turns(id, conversation_id),
  UNIQUE (turn_id, role)
);
CREATE INDEX chat_messages_conversation_idx ON public.chat_messages(conversation_id, turn_id);
CREATE TRIGGER chat_messages_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.chat_messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_activity_mutation();

-- Count dispatch attempts, including retries, across conversations and workers.
CREATE TABLE public.chat_dispatches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES public.profiles(id),
  turn_id UUID NOT NULL REFERENCES public.chat_turns(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX chat_dispatches_student_time_idx ON public.chat_dispatches(student_id, created_at DESC);

REVOKE ALL ON public.chat_conversations, public.chat_turns, public.chat_messages, public.chat_dispatches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.chat_dispatches_id_seq FROM PUBLIC, anon, authenticated;
COMMIT;
