import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deletedConversation, unresolvedQuestions, chatHistory, chatReply, conversationPage, pendingQuestions, saveQuestion, validateChat } from '../src/lib/chat.ts'
const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
function memory() {
  const items = new Map<string, string>()
  return { get length() { return items.size }, key: (n: number) => [...items.keys()][n] ?? null, getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v) }, removeItem: (k: string) => { items.delete(k) }, clear: () => items.clear() }
}
test('chat validates byte limits, exact code, and Unicode', () => {
  const input = { message: 'Help', current_code: '', attempt_id: null }
  assert.equal(validateChat(input), null)
  assert.equal(validateChat({ ...input, current_code: null }), null)
  assert.equal(validateChat({ ...input, current_code: '😀\r\n  x = 1\n' }), null)
  for (const message of ['', '  ', '\0', '\ud800', '😀'.repeat(2049)]) assert.ok(validateChat({ ...input, message }))
  assert.ok(validateChat({ ...input, current_code: 'x'.repeat(65537) }))
  assert.ok(validateChat({ ...input, attempt_id: 'bad' }))
})
test('pending questions isolate users, conversations and actions and freeze input', () => {
  const storage = memory(), input = { message: 'Why?', current_code: 'x=1\r\n', attempt_id: other }
  const first = saveQuestion('user', id, input, storage)
  const second = saveQuestion('user', id, input, storage)
  input.current_code = 'changed'
  assert.notEqual(first.key, second.key)
  assert.equal(pendingQuestions('user', id, storage)[0].input.current_code, 'x=1\r\n')
  assert.deepEqual(pendingQuestions('other-user', id, storage), [])
  assert.deepEqual(pendingQuestions('user', other, storage), [])
  assert.equal(pendingQuestions('user', id, storage).length, 2)
  assert.throws(() => saveQuestion('user', id, input, { ...storage, setItem() { throw Error('full') } }), /full/)
})
test('chat responses reject mismatched ownership and malformed turns but accept arbitrary sources safely as data', () => {
  const reply = { conversation_id: id, turn_id: id, student_message_id: id, assistant_message_id: other, answer: '<script>not HTML</script>', sources: [{ arbitrary: '<img onerror=alert(1)>' }] }
  assert.deepEqual(chatReply(reply, id), reply)
  assert.throws(() => chatReply(reply, other))
  assert.throws(() => chatReply({ ...reply, answer: '' }, id))
  assert.throws(() => chatHistory({ conversation_id: id, turns: [{ sequence: 1 }], next_after: null }, id))
  assert.throws(() => conversationPage({ conversations: [], next_after: -1 }, id))
  assert.deepEqual(chatHistory({ conversation_id: id, protocol_version: 2, can_send: true, blocking_turn_id: null, turns: [], next_after: null }, id), { protocol_version: 2, can_send: true, blocking_turn_id: null, turns: [], next_after: null })
})


test('stateful history validates conversation-wide blocking independently of the loaded page', () => {
  const page = { conversation_id: id, protocol_version: 2, can_send: false, blocking_turn_id: other, turns: [], next_after: 20 }
  assert.equal(chatHistory(page, id).blocking_turn_id, other)
  assert.throws(() => chatHistory({ ...page, can_send: true }, id))
  assert.throws(() => chatHistory({ ...page, protocol_version: 3 }, id))
  assert.throws(() => chatHistory({ ...page, protocol_version: 1, can_send: true, blocking_turn_id: null }, id))
  assert.doesNotThrow(() => deletedConversation({ conversation_id: id, deleted: true }, id))
  assert.throws(() => deletedConversation({ conversation_id: other, deleted: true }, id))
  assert.throws(() => deletedConversation({ conversation_id: id, deleted: false }, id))
})
test('only definite failed history releases pending questions; completed history alone is not a replay', () => {
  const pending = saveQuestion('user', id, { message: 'Help', current_code: '', attempt_id: null }, memory())
  const turn = { turn_id: id, sequence: 1, idempotency_key: pending.key, attempt_id: null, status: 'failed' as const, error_code: null, created_at: '2026-11-28T12:00:00Z', completed_at: null, messages: [] }
  assert.deepEqual(unresolvedQuestions([pending], [turn]), [])
  for (const status of ['processing', 'recovery_required', 'completed'] as const) assert.equal(unresolvedQuestions([pending], [{ ...turn, status }]).length, 1)
  assert.equal(unresolvedQuestions([pending], []).length, 1)
})
