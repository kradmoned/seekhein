BEGIN;
SET LOCAL lock_timeout = '5s';

-- Stop/drain the old backend before this protocol change. Do not strand an
-- active stateless request while freezing existing conversations for reading.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.chat_turns WHERE status = 'processing') THEN
    RAISE EXCEPTION 'Finish or recover active chat turns before migrating the tutor protocol';
  END IF;
END $$;

ALTER TABLE public.chat_conversations
  ADD COLUMN protocol_version SMALLINT NOT NULL DEFAULT 1 CHECK (protocol_version IN (1,2)),
  ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','deleting','deleted')),
  ADD COLUMN acknowledged_context_sha256 TEXT CHECK (acknowledged_context_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN cleanup_token UUID,
  ADD COLUMN cleanup_until TIMESTAMPTZ,
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD CONSTRAINT chat_cleanup_lease_valid CHECK (
    (cleanup_token IS NULL AND cleanup_until IS NULL)
    OR (lifecycle = 'deleting' AND cleanup_token IS NOT NULL AND cleanup_until IS NOT NULL)
  ),
  ADD CONSTRAINT chat_deleted_timestamp_valid CHECK ((lifecycle = 'deleted') = (deleted_at IS NOT NULL));
-- Historical chats remain readable; never re-send them to reconstruct AI history.
ALTER TABLE public.chat_conversations ALTER COLUMN protocol_version SET DEFAULT 2;

ALTER TABLE public.chat_turns
  DROP CONSTRAINT chat_turns_status_check,
  ADD CONSTRAINT chat_turns_status_check CHECK (status IN ('processing','completed','failed','recovery_required')),
  ADD COLUMN lab_context_sha256 TEXT CHECK (lab_context_sha256 ~ '^[0-9a-f]{64}$');

-- Preserve the rate ledger when a user deletes chat content.
ALTER TABLE public.chat_dispatches
  DROP CONSTRAINT chat_dispatches_turn_id_fkey,
  ALTER COLUMN turn_id DROP NOT NULL,
  ADD CONSTRAINT chat_dispatches_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES public.chat_turns(id) ON DELETE SET NULL;

-- Messages remain immutable. Deletion is allowed only within a coordinated
-- cleanup transaction, while the parent conversation is marked deleting.
DROP TRIGGER chat_messages_append_only ON public.chat_messages;
CREATE TRIGGER chat_messages_append_only BEFORE UPDATE OR TRUNCATE ON public.chat_messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_activity_mutation();
CREATE FUNCTION public.guard_chat_message_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chat_conversations WHERE id=OLD.conversation_id AND lifecycle='deleting') THEN
    RAISE EXCEPTION 'Chat messages can only be deleted during conversation cleanup' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER chat_messages_guard_delete BEFORE DELETE ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_chat_message_delete();
REVOKE ALL ON FUNCTION public.guard_chat_message_delete() FROM PUBLIC, anon, authenticated;
COMMIT;
