import { createHash, randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import { pool } from "./db"
import type { ChatInput } from "./chat-request"
import { askTutor, ChatError, chatLeaseSeconds, tutorConfiguration, type TutorContext } from "./tutor"

const conversationAccess = `SELECT c.id, c.lab_id FROM public.chat_conversations c
  JOIN public.labs l ON l.id = c.lab_id
  JOIN public.course_enrollments e ON e.course_id = l.course_id AND e.student_id = c.student_id
  WHERE c.id = $1 AND c.student_id = $2`
type Database = Pick<PoolClient, "query">
async function requireConversation(db: Database, conversationId: string, studentId: string, lock = false) {
  const result = await db.query<{ id: string; lab_id: string }>(conversationAccess + (lock ? " FOR UPDATE OF c FOR SHARE OF e" : ""), [conversationId, studentId])
  if (!result.rows[0]) throw new ChatError(404, "CONVERSATION_NOT_FOUND", "Conversation not found")
  return result.rows[0]
}
async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let destroy = false
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { destroy = true }
    throw error
  } finally { client.release(destroy) }
}
async function requireLab(db: Database, labId: string, studentId: string) {
  const access = await db.query(`SELECT l.id FROM public.labs l JOIN public.course_enrollments e ON e.course_id=l.course_id
    WHERE l.id=$1 AND e.student_id=$2`, [labId, studentId])
  if (!access.rows[0]) throw new ChatError(404, "LAB_NOT_FOUND", "Lab not found")
}
export async function createConversation(labId: string, studentId: string) {
  return transaction(async (client) => {
    await requireLab(client, labId, studentId)
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`chat-rate:${studentId}`])
    const count = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM public.chat_conversations
      WHERE student_id=$1 AND created_at > clock_timestamp() - interval '1 hour'`, [studentId])
    if (count.rows[0].count >= 20) throw new ChatError(429, "CONVERSATION_RATE_LIMIT", "Too many new conversations. Reuse an existing conversation.", 60)
    const result = await client.query(`INSERT INTO public.chat_conversations (lab_id,student_id) VALUES ($1,$2)
      RETURNING id AS conversation_id,lab_id,created_at,updated_at`, [labId, studentId])
    return result.rows[0]
  })
}
export async function listConversations(labId: string, studentId: string, offset: number, limit: number) {
  await requireLab(pool, labId, studentId)
  const result = await pool.query(`SELECT id AS conversation_id,lab_id,created_at,updated_at FROM public.chat_conversations
    WHERE lab_id=$1 AND student_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`, [labId, studentId, limit + 1, offset])
  return { conversations: result.rows.slice(0, limit), next_after: result.rows.length > limit ? offset + limit : null }
}
export async function listMessages(conversationId: string, studentId: string, after: number, limit: number) {
  await requireConversation(pool, conversationId, studentId)
  const turns = await pool.query(`SELECT t.id AS turn_id,t.sequence,t.idempotency_key,t.attempt_id,
    CASE WHEN t.status='processing' AND t.lease_until <= clock_timestamp() THEN 'failed' ELSE t.status END AS status,
    CASE WHEN t.status='processing' AND t.lease_until <= clock_timestamp() THEN 'TURN_INTERRUPTED' ELSE t.error_code END AS error_code,
    t.created_at,t.completed_at,
    (SELECT json_agg(json_build_object('id',m.id,'role',m.role,'content',m.content,'sources',m.sources,'created_at',m.created_at)
      ORDER BY CASE m.role WHEN 'user' THEN 0 ELSE 1 END) FROM public.chat_messages m WHERE m.turn_id=t.id) AS messages
    FROM public.chat_turns t WHERE t.conversation_id=$1 AND t.sequence>$2 ORDER BY t.sequence LIMIT $3`, [conversationId, after, limit + 1])
  return { conversation_id: conversationId, turns: turns.rows.slice(0, limit), next_after: turns.rows.length > limit ? turns.rows[limit - 1].sequence : null }
}
type Turn = {
  id: string; sequence: number; payload_sha256: string; status: string; context_snapshot: TutorContext
}
type Reply = {
  conversation_id: string; turn_id: string; student_message_id: string; assistant_message_id: string; answer: string; sources: unknown[]
}
async function savedReply(db: Database, conversationId: string, turnId: string): Promise<Reply> {
  const messages = await db.query<{ id: string; role: string; content: string; sources: unknown[] }>(
    "SELECT id,role,content,sources FROM public.chat_messages WHERE turn_id=$1", [turnId])
  const student = messages.rows.find((m) => m.role === "user")
  const assistant = messages.rows.find((m) => m.role === "assistant")
  if (!student || !assistant) throw new Error("Incomplete completed turn")
  return { conversation_id: conversationId, turn_id: turnId, student_message_id: student.id, assistant_message_id: assistant.id, answer: assistant.content, sources: assistant.sources }
}
type Claimed = { turnId: string; lease: string; context: TutorContext }

async function claimTurn(conversationId: string, studentId: string, key: string, input: ChatInput): Promise<Claimed | Reply> {
  const digest = createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")
  return transaction(async (client) => {
    // Short locks only: different students do not share a lock, and the AI call
    // happens after COMMIT so it cannot occupy a database worker/transaction.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`chat-rate:${studentId}`])
    const conversation = await requireConversation(client, conversationId, studentId, true)
    const prior = await client.query<Turn>("SELECT id,sequence,payload_sha256,status,context_snapshot FROM public.chat_turns WHERE conversation_id=$1 AND idempotency_key=$2", [conversationId, key])
    let turn = prior.rows[0]
    if (turn && turn.payload_sha256 !== digest) throw new ChatError(409, "IDEMPOTENCY_KEY_REUSED", "This key was used for a different message or code context")
    if (turn?.status === "completed") return savedReply(client, conversationId, turn.id)
    const active = await client.query("SELECT id FROM public.chat_turns WHERE conversation_id=$1 AND status='processing' AND lease_until>clock_timestamp()", [conversationId])
    if (active.rows[0]) throw new ChatError(409, "TURN_PROCESSING", "A message in this conversation is processing. Retry shortly.", 2)
    tutorConfiguration()
    const rate = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM public.chat_dispatches
      WHERE student_id=$1 AND created_at>clock_timestamp()-interval '1 minute'`, [studentId])
    if (rate.rows[0].count >= 10) throw new ChatError(429, "CHAT_RATE_LIMIT", "Too many assistant requests. Retry shortly.", 60)
    await client.query(`UPDATE public.chat_turns SET status='failed',lease_token=NULL,lease_until=NULL,error_code='TURN_INTERRUPTED'
      WHERE conversation_id=$1 AND status='processing'`, [conversationId])
    const lease = randomUUID()
    if (!turn) {
      const attempt = await client.query<{ id: string; code: string; tutor_output: Record<string, unknown> | null }>(
        `SELECT id,code,tutor_output FROM public.submissions WHERE lab_id=$1 AND student_id=$2
          AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC,id DESC LIMIT 1`, [conversation.lab_id, studentId, input.attempt_id])
      if (input.attempt_id && !attempt.rows[0]) throw new ChatError(404, "ATTEMPT_NOT_FOUND", "Execution attempt not found")
      const history = await client.query<{ role: "user" | "assistant"; content: string }>(`SELECT m.role,m.content FROM public.chat_messages m
        JOIN (SELECT id,sequence FROM public.chat_turns WHERE conversation_id=$1 AND status='completed' ORDER BY sequence DESC LIMIT 3) t ON t.id=m.turn_id
        ORDER BY t.sequence,CASE m.role WHEN 'user' THEN 0 ELSE 1 END`, [conversationId])
      const selected = attempt.rows[0]
      const context: TutorContext = {
        conversation_id: conversationId, message: input.message, recent_messages: history.rows,
        current_code: input.current_code, executed_code: selected?.code ?? null,
        output_error: null, validation_feedback: selected?.tutor_output ?? null,
      }
      const sequence = await client.query<{ sequence: number }>(`UPDATE public.chat_conversations SET next_sequence=next_sequence+1,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING next_sequence-1 AS sequence`, [conversationId])
      const inserted = await client.query<Turn>(`INSERT INTO public.chat_turns
        (conversation_id,student_id,sequence,idempotency_key,payload_sha256,attempt_id,context_snapshot,status,lease_token,lease_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7::json,'processing',$8,clock_timestamp()+$9*interval '1 second')
        RETURNING id,sequence,payload_sha256,status,context_snapshot`,
      [conversationId, studentId, sequence.rows[0].sequence, key, digest, selected?.id ?? null, JSON.stringify(context), lease, chatLeaseSeconds])
      turn = inserted.rows[0]
      await client.query("INSERT INTO public.chat_messages (conversation_id,turn_id,role,content) VALUES ($1,$2,'user',$3)", [conversationId, turn.id, input.message])
    } else {
      await client.query(`UPDATE public.chat_turns SET status='processing',lease_token=$2,lease_until=clock_timestamp()+$3*interval '1 second',error_code=NULL
        WHERE id=$1`, [turn.id, lease, chatLeaseSeconds])
    }
    await client.query("INSERT INTO public.chat_dispatches (student_id,turn_id) VALUES ($1,$2)", [studentId, turn.id])
    return { turnId: turn.id, lease, context: turn.context_snapshot }
  })
}

export async function sendChatMessage(conversationId: string, studentId: string, key: string, input: ChatInput): Promise<Reply> {
  const claimed = await claimTurn(conversationId, studentId, key, input)
  if (!("lease" in claimed)) return claimed
  try {
    const answer = await askTutor(claimed.context)
    return await transaction(async (client) => {
      await requireConversation(client, conversationId, studentId, true)
      const turn = await client.query("SELECT id FROM public.chat_turns WHERE id=$1 AND lease_token=$2 AND status='processing' FOR UPDATE", [claimed.turnId, claimed.lease])
      if (!turn.rows[0]) throw new ChatError(409, "TURN_LEASE_LOST", "This request was recovered by another worker. Retry the same key.", 2)
      await client.query("INSERT INTO public.chat_messages (conversation_id,turn_id,role,content,sources) VALUES ($1,$2,'assistant',$3,$4::json)", [conversationId, claimed.turnId, answer.answer, JSON.stringify(answer.sources)])
      await client.query("UPDATE public.chat_turns SET status='completed',lease_token=NULL,lease_until=NULL,error_code=NULL,completed_at=clock_timestamp() WHERE id=$1", [claimed.turnId])
      await client.query("UPDATE public.chat_conversations SET updated_at=clock_timestamp() WHERE id=$1", [conversationId])
      return savedReply(client, conversationId, claimed.turnId)
    })
  } catch (error) {
    // A lost COMMIT acknowledgement might mean the answer is already durable.
    // Never overwrite completed work or a newer worker's lease.
    try {
      await pool.query(`UPDATE public.chat_turns SET status='failed',lease_token=NULL,lease_until=NULL,error_code=$3
        WHERE id=$1 AND lease_token=$2 AND status='processing'`, [claimed.turnId, claimed.lease, error instanceof ChatError ? error.code : "CHAT_STORAGE_FAILED"])
    } catch { /* Lease expiry allows recovery even when the database is down. */ }
    console.error("Tutor turn failed", {
      conversation_id: conversationId, turn_id: claimed.turnId,
      code: error instanceof ChatError ? error.code : "CHAT_STORAGE_FAILED",
      upstream_status: error instanceof ChatError ? error.upstreamStatus : undefined,
    })
    throw error
  }
}
