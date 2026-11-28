import { randomUuid } from './uuid.ts'

export type Conversation = { conversation_id: string; lab_id: string; created_at: string; updated_at: string; protocol_version: 1 | 2; lifecycle: 'active' | 'deleting' }
export type ChatInput = { message: string; current_code: string | null; attempt_id: string | null }
export type PendingChat = { key: string; conversation_id: string; input: ChatInput }
export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; sources: unknown[]; created_at: string }
export type ChatTurn = { turn_id: string; sequence: number; idempotency_key: string; attempt_id: string | null; status: 'processing' | 'completed' | 'failed' | 'recovery_required'; error_code: string | null; created_at: string; completed_at: string | null; messages: ChatMessage[] }
export type ChatReply = { conversation_id: string; turn_id: string; student_message_id: string; assistant_message_id: string; answer: string; sources: unknown[] }
export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const text = (v: unknown): v is string => typeof v === 'string'
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v))
function check(v: unknown): asserts v { if (!v) throw Error('Invalid assistant response. Your pending question has been kept for recovery.') }
function object(v: unknown): Record<string, unknown> { check(v && typeof v === 'object' && !Array.isArray(v)); return v as Record<string, unknown> }
function cursor(v: unknown) { check(v === null || Number.isSafeInteger(v) && Number(v) > 0); return v as number | null }
export function conversation(value: unknown, labId: string): Conversation {
  const v = object(value); check(isUuid(v.conversation_id) && v.lab_id === labId && date(v.created_at) && date(v.updated_at) && [1, 2].includes(Number(v.protocol_version)) && typeof v.protocol_version === 'number' && ['active', 'deleting'].includes(String(v.lifecycle))); return v as Conversation
}
export function conversationPage(value: unknown, labId: string) {
  const v = object(value); check(Array.isArray(v.conversations)); return { conversations: v.conversations.map(c => conversation(c, labId)), next_after: cursor(v.next_after) }
}
export function chatHistory(value: unknown, id: string) {
  const v = object(value); check(v.conversation_id === id && [1, 2].includes(Number(v.protocol_version)) && typeof v.protocol_version === 'number' && typeof v.can_send === 'boolean' && (v.blocking_turn_id === null || isUuid(v.blocking_turn_id)) && !(v.can_send && (v.protocol_version === 1 || v.blocking_turn_id !== null)) && Array.isArray(v.turns))
  let previous = 0
  for (const raw of v.turns) {
    const t = object(raw)
    check(isUuid(t.turn_id) && isUuid(t.idempotency_key) && Number.isSafeInteger(t.sequence) && Number(t.sequence) > previous && (t.attempt_id === null || isUuid(t.attempt_id)) && ['processing', 'completed', 'failed', 'recovery_required'].includes(String(t.status)) && (t.error_code === null || text(t.error_code)) && date(t.created_at) && (t.completed_at === null || date(t.completed_at)) && Array.isArray(t.messages))
    previous = Number(t.sequence)
    for (const rawMessage of t.messages) { const m = object(rawMessage); check(isUuid(m.id) && ['user', 'assistant'].includes(String(m.role)) && text(m.content) && Array.isArray(m.sources) && date(m.created_at)) }
  }
  return { protocol_version: v.protocol_version as 1 | 2, can_send: v.can_send as boolean, blocking_turn_id: v.blocking_turn_id as string | null, turns: v.turns as ChatTurn[], next_after: cursor(v.next_after) }
}
export function chatReply(value: unknown, id: string): ChatReply {
  const v = object(value); check(v.conversation_id === id && isUuid(v.turn_id) && isUuid(v.student_message_id) && isUuid(v.assistant_message_id) && text(v.answer) && v.answer.trim() && new TextEncoder().encode(v.answer).length <= 32768 && Array.isArray(v.sources)); return v as ChatReply
}
export function validateChat(input: ChatInput): string | null {
  for (const [label, value, max] of [['Question', input.message, 8192], ['Editor code', input.current_code, 65536]] as const) {
    if (value === null && label === 'Editor code') continue
    if (typeof value !== 'string' || value.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return `${label} contains invalid characters.`
    if (new TextEncoder().encode(value).length > max) return `${label} exceeds ${max / 1024} KiB.`
  }
  if (!input.message.trim()) return 'Enter a question.'
  if (input.attempt_id !== null && !isUuid(input.attempt_id)) return 'Invalid execution reference. Run your code again.'
  return null
}
export const chatPrefix = (userId: string, id: string) => `lab-chat:${userId}:${id}:`
export function saveQuestion(userId: string, id: string, input: ChatInput, storage: Storage): PendingChat {
  const error = validateChat(input); if (error) throw Error(error)
  const pending = { key: randomUuid(), conversation_id: id, input: { ...input } }
  storage.setItem(chatPrefix(userId, id) + pending.key, JSON.stringify(pending))
  return pending
}
export function pendingQuestions(userId: string, id: string, storage: Storage): PendingChat[] {
  const prefix = chatPrefix(userId, id), found: PendingChat[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i); if (!key?.startsWith(prefix)) continue
    const p = JSON.parse(storage.getItem(key)!) as PendingChat
    if (!p || !isUuid(p.key) || key !== prefix + p.key || p.conversation_id !== id || !p.input || validateChat(p.input)) throw Error('A saved question could not be read. Recovery data has been preserved.')
    found.push(p)
  }
  return found
}

export function deletedConversation(value: unknown, id: string) {
  const v = object(value); check(v.conversation_id === id && v.deleted === true)
}
/** Only a confirmed failed turn releases a locally pending action for new sends. */
export function unresolvedQuestions(pending: PendingChat[], turns: ChatTurn[]) {
  return pending.filter(p => !turns.some(t => t.idempotency_key.toLowerCase() === p.key.toLowerCase() && t.status === 'failed'))
}
