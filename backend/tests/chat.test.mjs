import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { loader } from './helpers/load.mjs'
const id = randomUUID()
const input = { message: 'Why?', current_code: 'print(1)', attempt_id: null }
function harness(options = {}) {
  const calls = []
  const load = loader({ modules: {
    'lib/auth.ts': { requireUser: async (_req, role) => {
      assert.equal(role, 'student')
      if (options.authError) return { error: Response.json({ error: 'Denied' }, { status: options.authError }) }
      return { user: { id, role: 'student' } }
    } },
    'lib/chat.ts': {
      sendChatMessage: async (...args) => { calls.push(args); return { answer: 'Hint', sources: [] } },
      listMessages: async (...args) => { calls.push(args); return { turns: [] } },
      listConversations: async (...args) => { calls.push(args); return { conversations: [] } },
      createConversation: async (...args) => { calls.push(args); return { conversation_id: id } },
    },
  } })
  const route = load('app/api/conversations/[conversationId]/messages/route.ts')
  return { calls, route, send(body = input, key = id, contentType = 'application/json') {
    return route.POST(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': contentType, 'Idempotency-Key': key }, body: JSON.stringify(body) }), { params: Promise.resolve({ conversationId: id }) })
  } }
}
test('chat request preserves code, explicit nulls and canonical UUIDs', async () => {
  const h = harness()
  const response = await h.send({ ...input, current_code: '  # 😀\r\n', attempt_id: id.toUpperCase() }, id.toUpperCase())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(h.calls[0][2], id)
  assert.equal(h.calls[0][3].attempt_id, id)
  assert.equal(h.calls[0][3].current_code, '  # 😀\r\n')
})
test('chat rejects browser history, invalid text and oversized code before dispatch', async () => {
  for (const [body, status] of [
    [{ message: 'hi' }, 422], [{ ...input, message: '  ' }, 422], [{ ...input, message: '\0' }, 422],
    [{ ...input, current_code: '\ud800' }, 422], [{ ...input, recent_messages: [] }, 422],
    [{ ...input, validation_feedback: {} }, 422], [{ ...input, attempt_id: 'bad' }, 422],
    [{ ...input, current_code: 'é'.repeat(32769) }, 413], [{ ...input, message: 'x'.repeat(8193) }, 413],
  ]) {
    const h = harness(); assert.equal((await h.send(body)).status, status); assert.equal(h.calls.length, 0)
  }
  assert.equal((await harness().send(input, 'invalid')).status, 400)
  assert.equal((await harness().send(input, id, 'text/plain')).status, 415)
})
test('chat requires student authentication before reading input', async () => {
  for (const status of [401, 403]) {
    const h = harness({ authError: status })
    assert.equal((await h.send(null, 'invalid')).status, status)
    assert.equal(h.calls.length, 0)
  }
})
test('history pagination rejects malformed cursors', async () => {
  const h = harness()
  for (const query of ['after=-1', 'limit=0', 'limit=51', 'after=2147483648']) {
    assert.equal((await h.route.GET(new Request(`http://localhost?${query}`), { params: Promise.resolve({ conversationId: id }) })).status, 400)
  }
  assert.equal(h.calls.length, 0)
})
function tutorHarness(options = {}) {
  const requests = []
  const load = loader({ globals: {
    process: { env: { TUTOR_API_URL: 'http://tutor.test', ...options.env } },
    ...(options.abortSignal ? { AbortSignal: options.abortSignal } : {}),
    fetch: async (url, init) => { requests.push({ url: String(url), ...init }); return options.fetch ? options.fetch(url, init) : Response.json(options.response ?? { status: 'success', conversation_id: id, answer: 'Think about the loop.', sources: [{ arbitrary: true }] }) },
  } })
  return { ...load('lib/tutor.ts'), requests }
}
const context = { conversation_id: id, message: 'New question', current_code: null, executed_code: null, output_error: null, validation_feedback: null }
test('tutor adapter forwards all feedback intact and sends explicit nulls without scenario', async () => {
  const h = tutorHarness({ env: { TUTOR_API_TOKEN: 'server-only' } })
  const feedback = { failures: [{ detail: '<test_suite>\n\u0000full details' }], arbitrary: { intact: true } }
  const answer = await h.askTutor({ ...context, validation_feedback: feedback, lab_context: { title: "Lab", instructions: "Prompt", starter: "pass", tests: "PRIVATE_TESTS", solution: "PRIVATE_SOLUTION" } }, id)
  assert.equal(answer.answer, 'Think about the loop.')
  assert.equal(h.requests[0].url, 'http://tutor.test/api/v1/tutor')
  const sent = JSON.parse(h.requests[0].body)
  assert.deepEqual(sent.validation_feedback, feedback)
  assert.equal(sent.lab_context.tests, 'PRIVATE_TESTS')
  assert.equal('recent_messages' in sent, false)
  assert.equal('idempotency_key' in sent, false)
  assert.equal(h.requests[0].headers['Idempotency-Key'], id)
  assert.equal(h.requests[0].headers.Authorization, 'Bearer server-only')
  assert.equal(h.requests[0].redirect, 'error')
})
test('AI errors and malformed answers never expose upstream internals', async () => {
  for (const [upstream, expected] of [[400,502], [401,503], [403,503], [422,502], [500,502], [429,429], [503,503]]) {
    const h = tutorHarness({ fetch: async () => Response.json({ detail: 'PRIVATE_DETAIL' }, { status: upstream }) })
    await assert.rejects(h.askTutor(context, id), (e) => e.status === expected && !e.message.includes('PRIVATE_DETAIL'))
  }
  for (const response of [null, {}, { status: 'success', conversation_id: randomUUID(), answer: 'x', sources: [] },
    { status: 'success', conversation_id: id, answer: '\0', sources: [] },
    { status: 'success', conversation_id: id, answer: 'x'.repeat(32769), sources: [] },
    { status: 'success', conversation_id: id, answer: 'x', sources: {} }]) {
    const h = tutorHarness({ fetch: async () => Response.json(response) })
    await assert.rejects(h.askTutor(context, id), (e) => e.status === 502)
  }
  await assert.rejects(tutorHarness({ fetch: async () => new Response('x'.repeat(262145)) }).askTutor(context, id), (e) => e.status === 502)
})
test('missing tutor URL is a configuration error; deadlines cover the complete request', async () => {
  const h = tutorHarness({ env: { TUTOR_API_URL: '' } })
  await assert.rejects(h.askTutor(context, id), (e) => e.status === 503)
  assert.equal(h.requests.length, 0)
  const signal = { aborted: false }
  const timed = tutorHarness({ abortSignal: { timeout(ms) { assert.equal(ms, 45000); return signal } }, fetch: async () => { signal.aborted = true; throw new Error('timeout') } })
  await assert.rejects(timed.askTutor(context, id), (e) => e.status === 504)
})


test('tutor cleanup is authenticated and treats an absent session as success', async () => {
  for (const deleted of [true, false]) {
    const h = tutorHarness({ env: { TUTOR_API_TOKEN: 'server-token' }, response: { status: 'success', conversation_id: id, deleted } })
    await h.deleteTutorSession(id)
    assert.equal(h.requests[0].url, `http://tutor.test/api/v1/sessions/${id}`)
    assert.equal(h.requests[0].method, 'DELETE')
    assert.equal(h.requests[0].headers.Authorization, 'Bearer server-token')
    assert.equal(h.requests[0].body, undefined)
  }
  await assert.rejects(tutorHarness({ response: { status: 'success', conversation_id: randomUUID(), deleted: true } }).deleteTutorSession(id), (e) => e.outcomeUnknown)
})
test('transport loss and malformed success are uncertain; documented failures are definite', async () => {
  await assert.rejects(tutorHarness({ fetch: async () => { throw new Error('lost response') } }).askTutor(context, id), (e) => e.outcomeUnknown)
  await assert.rejects(tutorHarness({ response: {} }).askTutor(context, id), (e) => e.outcomeUnknown)
  await assert.rejects(tutorHarness({ fetch: async () => Response.json({}, { status: 503 }) }).askTutor(context, id), (e) => !e.outcomeUnknown)
})
