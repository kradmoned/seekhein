import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import pg from 'pg'
import { loader } from '../helpers/load.mjs'

test('chat persistence, context isolation and recovery against PostgreSQL', { skip: !process.env.DATABASE_URL }, async (t) => {
  const schema = `chat_test_${randomUUID().replaceAll('-', '')}`
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 30000 })
  const rewrite = (sql) => sql.replaceAll('public.', `${schema}.`)
  const query = (sql, args) => db.query(rewrite(sql), args)
  const student = randomUUID(), second = randomUUID(), outsider = randomUUID(), teacher = randomUUID(), lab = randomUUID(), otherLab = randomUUID(), course = randomUUID()
  const feedback = { status: 'runtime_error', internal_error: 'PRIVATE_TRACE\u0000FULL', failures: [{ detail: 'PRIVATE_TEST_SOURCE' }], custom: { untouched: true } }
  let failSave = false, loseCommit = false
  const adapter = {
    query,
    async connect() {
      const client = await db.connect()
      return {
        async query(sql, args) {
          if (failSave && sql.includes("'assistant'")) { failSave = false; throw new Error('Simulated save failure') }
          const result = await client.query(rewrite(sql), args)
          if (loseCommit && sql === 'COMMIT') { loseCommit = false; throw new Error('Lost COMMIT acknowledgement') }
          return result
        },
        release: (destroy) => client.release(destroy),
      }
    },
  }
  const captured = []
  let tutorBehavior
  const load = loader({ modules: {
    'lib/db.ts': { pool: adapter },
    'lib/auth.ts': { requireUser: async (req, role) => {
      const id = req.headers.get('x-test-user')
      if (!id) return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
      if (id === teacher && role === 'student') return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) }
      return { user: { id, role: id === teacher ? 'teacher' : 'student' } }
    } },
  }, globals: {
    process: { env: { TUTOR_API_URL: 'http://tutor.test' } },
    fetch: async (_url, init) => {
      const context = JSON.parse(init.body); captured.push(context)
      if (tutorBehavior) return tutorBehavior(context)
      return Response.json({ status: 'success', conversation_id: context.conversation_id, answer: `Hint for ${context.message}`, sources: [{ arbitrary: 'metadata' }] })
    },
  } })
  const conversations = load('app/api/labs/[id]/conversations/route.ts')
  const messages = load('app/api/conversations/[conversationId]/messages/route.ts')
  const request = (user = student, body, key = randomUUID(), queryString = '') => new Request(`http://localhost/${queryString}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-test-user': user, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  async function create(user = student, labId = lab) {
    const response = await conversations.POST(request(user), { params: Promise.resolve({ id: labId }) })
    assert.equal(response.status, 201)
    return (await response.json()).conversation_id
  }
  const params = (id) => ({ params: Promise.resolve({ conversationId: id }) })
  const send = (id, body = { message: 'Why?', current_code: null }, key = randomUUID(), user = student) => messages.POST(request(user, body, key), params(id))
  async function read(id, user = student, page = '') {
    const response = await messages.GET(request(user, undefined, randomUUID(), page), params(id))
    assert.equal(response.status, 200)
    return response.json()
  }
  const accepted = async (response) => { assert.equal(response.status, 200, await response.clone().text()); return response.json() }
  async function scenario(name, fn) {
    await t.test(name, async () => {
      await query('DELETE FROM public.chat_dispatches')
      try { await fn() } catch (error) { t.diagnostic(error.stack); throw error }
      finally { tutorBehavior = undefined; failSave = false; loseCommit = false }
    })
  }
  try {
    await db.query(`CREATE SCHEMA ${schema}`)
    await query(`CREATE TABLE public.profiles(id uuid PRIMARY KEY);
      CREATE TABLE public.labs(id uuid PRIMARY KEY,course_id uuid NOT NULL);
      CREATE TABLE public.course_enrollments(course_id uuid NOT NULL,student_id uuid NOT NULL,PRIMARY KEY(course_id,student_id));
      CREATE TABLE public.submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lab_id uuid NOT NULL,student_id uuid NOT NULL,code text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE FUNCTION public.reject_activity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Append only'; END;$$;`)
    await query(readFileSync(new URL('../../db/migrations/20261128_003_ai_chat.sql', import.meta.url), 'utf8'))
    await query('INSERT INTO public.profiles(id) VALUES ($1),($2),($3),($4)', [student, second, outsider, teacher])
    await query('INSERT INTO public.labs(id,course_id) VALUES ($1,$2),($3,$4)', [lab, course, otherLab, randomUUID()])
    await query('INSERT INTO public.course_enrollments(course_id,student_id) VALUES ($1,$2),($1,$3)', [course, student, second])
    const execution = (await query('INSERT INTO public.submissions(lab_id,student_id,code,tutor_output) VALUES ($1,$2,$3,$4::json) RETURNING id', [lab, student, 'executed code', JSON.stringify(feedback)])).rows[0].id

    await scenario('conversation ownership, enrollment and role checks protect all routes', async () => {
      const conv = await create()
      for (const user of [second, outsider, teacher]) {
        assert.equal((await send(conv, undefined, randomUUID(), user)).status, user === teacher ? 403 : 404)
        assert.equal((await messages.GET(request(user), params(conv))).status, user === teacher ? 403 : 404)
      }
      assert.equal((await conversations.POST(request(outsider), { params: Promise.resolve({ id: lab }) })).status, 404)
      assert.equal((await conversations.POST(request(student), { params: Promise.resolve({ id: otherLab }) })).status, 404)
      assert.equal((await conversations.GET(request(student), { params: Promise.resolve({ id: lab }) })).status, 200)
      assert.equal(captured.length, 0)
    })
    await scenario('three completed exchanges, exact execution context, replay and reload', async () => {
      const conv = await create()
      for (let i=1; i<=4; i++) {
        await accepted(await send(conv, { message: `Question ${i}`, current_code: `edited ${i}`, attempt_id: execution }))
      }
      const key = randomUUID(), input = { message: 'Question 5', current_code: 'new unexecuted code', attempt_id: execution }
      const answer = await accepted(await send(conv, input, key))
      assert.equal(captured.at(-1).executed_code, 'executed code')
      assert.equal(captured.at(-1).current_code, input.current_code)
      assert.deepEqual(captured.at(-1).validation_feedback, feedback)
      assert.deepEqual(captured.at(-1).recent_messages, [2,3,4].flatMap((i) => [{ role: 'user', content: `Question ${i}` }, { role: 'assistant', content: `Hint for Question ${i}` }]))
      assert.equal('scenario' in captured.at(-1), false)
      const before = captured.length
      assert.deepEqual(await accepted(await send(conv, input, key)), answer)
      assert.equal(captured.length, before)
      assert.equal((await send(conv, { ...input, current_code: 'changed' }, key)).status, 409)
      const history = await read(conv)
      assert.equal(history.turns.length, 5)
      assert.ok(history.turns.every((turn) => turn.status === 'completed' && turn.messages.length === 2))
      assert.equal(history.turns.at(-1).messages[1].id, answer.assistant_message_id)
      assert.ok(!JSON.stringify(history).includes('PRIVATE_'))
      assert.ok(!JSON.stringify(answer).includes('PRIVATE_'))
      const firstPage = await read(conv, student, '?limit=2')
      assert.equal(firstPage.next_after, 2)
      assert.equal((await read(conv, student, '?after=2&limit=2')).turns[0].sequence, 3)
    })
    await scenario('attempts are scoped to student and lab; historical feedback stays null', async () => {
      const conv = await create(second)
      assert.equal((await send(conv, { message: 'Why?', current_code: null, attempt_id: execution }, randomUUID(), second)).status, 404)
      await accepted(await send(conv, undefined, randomUUID(), second))
      assert.equal(captured.at(-1).executed_code, null)
      assert.equal(captured.at(-1).validation_feedback, null)
      const historical = (await query('INSERT INTO public.submissions(lab_id,student_id,code) VALUES ($1,$2,$3) RETURNING id', [lab, second, 'old code'])).rows[0].id
      await accepted(await send(conv, { message: 'Earlier?', current_code: '', attempt_id: historical }, randomUUID(), second))
      assert.equal(captured.at(-1).executed_code, 'old code')
      assert.equal(captured.at(-1).validation_feedback, null)
      assert.equal(captured.at(-1).output_error, null)
    })
    await scenario('two students converse concurrently while one conversation rejects overlaps', async () => {
      const first = await create(), other = await create(second)
      let startedResolve, release
      const started = new Promise((resolve) => { startedResolve = resolve })
      tutorBehavior = async (context) => {
        if (context.conversation_id === first) { startedResolve(); await new Promise((resolve) => { release = resolve }) }
        return Response.json({ status: 'success', conversation_id: context.conversation_id, answer: 'Independent hint', sources: [] })
      }
      const key = randomUUID(), inFlight = send(first, undefined, key)
      await started
      try {
        assert.equal((await send(first, undefined, key)).status, 409)
        assert.equal((await send(first)).status, 409)
        await accepted(await send(other, undefined, randomUUID(), second))
        assert.equal(captured.at(-1).conversation_id, other)
        assert.deepEqual(captured.at(-1).recent_messages, [])
      } finally { release() }
      await accepted(await inFlight)
    })
    await scenario('save failure retries preserve snapshots and lost acknowledgements replay', async () => {
      const conv = await create(), key = randomUUID(), input = { message: 'Recover', current_code: 'snapshot' }
      failSave = true
      assert.equal((await send(conv, input, key)).status, 500)
      const original = captured.at(-1)
      const failed = await read(conv)
      assert.equal(failed.turns[0].status, 'failed')
      assert.equal(failed.turns[0].messages.length, 1)
      await query('INSERT INTO public.submissions(lab_id,student_id,code) VALUES ($1,$2,$3)', [lab, student, 'later execution'])
      tutorBehavior = (context) => {
        assert.deepEqual(context, original)
        loseCommit = true
        return Response.json({ status: 'success', conversation_id: conv, answer: 'Saved answer', sources: [] })
      }
      assert.equal((await send(conv, input, key)).status, 500)
      const before = captured.length
      const replay = await accepted(await send(conv, input, key))
      assert.equal(replay.answer, 'Saved answer')
      assert.equal(captured.length, before)
      assert.equal((await read(conv)).turns[0].messages.length, 2)
    })
    await scenario('failed turns are excluded and stale workers cannot overwrite recovered answers', async () => {
      const conv = await create(), input = { message: 'Expired worker', current_code: null }, key = randomUUID()
      let startedResolve, release
      const started = new Promise((resolve) => { startedResolve = resolve })
      tutorBehavior = async (context) => {
        startedResolve(); await new Promise((resolve) => { release = resolve })
        return Response.json({ status: 'success', conversation_id: context.conversation_id, answer: 'Stale answer', sources: [] })
      }
      const stale = send(conv, input, key)
      await started
      await query("UPDATE public.chat_turns SET lease_until=clock_timestamp()-interval '1 second' WHERE conversation_id=$1", [conv])
      assert.equal((await read(conv)).turns[0].error_code, 'TURN_INTERRUPTED')
      tutorBehavior = undefined
      try { await accepted(await send(conv, input, key)) } finally { release() }
      assert.equal((await stale).status, 409)
      assert.equal((await read(conv)).turns[0].messages[1].content, 'Hint for Expired worker')
      tutorBehavior = () => Response.json({ detail: 'PRIVATE_ERROR' }, { status: 500 })
      assert.equal((await send(conv, { message: 'Failed turn', current_code: null })).status, 502)
      tutorBehavior = undefined
      await accepted(await send(conv, { message: 'After failure', current_code: null }))
      assert.deepEqual(captured.at(-1).recent_messages.map((m) => m.content), ['Expired worker','Hint for Expired worker'])
    })
    await scenario('database rate limits span conversations; revoked enrollment blocks replay', async () => {
      const conv = await create(), key = randomUUID(), input = { message: 'Rate check', current_code: null }
      const result = await accepted(await send(conv, input, key))
      await query('INSERT INTO public.chat_dispatches(student_id,turn_id) SELECT $1,$2 FROM generate_series(1,10)', [student, result.turn_id])
      const before = captured.length
      assert.equal((await send(await create())).status, 429)
      assert.deepEqual(await accepted(await send(conv, input, key)), result)
      assert.equal(captured.length, before)
      await query('DELETE FROM public.course_enrollments WHERE student_id=$1', [student])
      assert.equal((await send(conv, input, key)).status, 404)
      assert.equal((await messages.GET(request(student), params(conv))).status, 404)
    })
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await db.end()
  }
})
