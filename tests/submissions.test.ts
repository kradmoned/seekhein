import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beginSubmission, pendingSubmissions, resolveSubmission, codeDigest, terminalSubmissionError } from '../src/lib/pending-submissions.ts'
import { parseLimit, submissionStatus, submitResult, execution } from '../src/lib/submission-contract.ts'
import { validateCode } from '../src/lib/workspace.ts'

function storage(): Storage {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v) }, removeItem: k => { values.delete(k) }, clear: () => values.clear() }
}
const result = { status: 'ok', results: [{ name: 'test_add', passed: true, error: null }], score: 100, passed: 1, total: 1 }
test('pending actions preserve exact source, isolate accounts/labs, and resolve independently', () => {
  const store = storage()
  const source = 'def café():\r\n    return "é"\n\n'
  const first = beginSubmission('a', 'lab', source, false, store)
  const second = beginSubmission('a', 'lab', 'other', false, store)
  beginSubmission('b', 'lab', 'private', false, store)
  beginSubmission('a', 'another', 'private', false, store)
  assert.notEqual(first.key, second.key)
  assert.deepEqual(pendingSubmissions('a', 'lab', store), [first, second])
  resolveSubmission('a', 'lab', first.key, store)
  assert.deepEqual(pendingSubmissions('a', 'lab', store), [second])
  assert.equal(pendingSubmissions('b', 'lab', store).length, 1)
})
test('unavailable storage prevents beginning an action', () => {
  const store = storage(); store.setItem = () => { throw Error('quota') }
  assert.throws(() => beginSubmission('a', 'lab', 'code', false, store), /quota/)
})
test('digest includes exact whitespace, line endings, and Unicode', async () => {
  const digest = await codeDigest('é\r\n  ')
  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.equal(digest, await codeDigest('é\r\n  '))
  assert.notEqual(digest, await codeDigest('é\n  '))
  assert.notEqual(digest, await codeDigest('é\r\n '))
})
test('submission limits and code validation respect contract', () => {
  assert.deepEqual(['1', '2', '3', '2147483647', 'unlimited'].map(parseLimit), [1, 2, 3, 2147483647, null])
  for (const value of ['0', '-1', '1.5', '2147483648', '', 'true', '1e2']) assert.throws(() => parseLimit(value))
  assert.match(validateCode('print("\0")'), /null/)
})
test('malformed successful responses cannot resolve a pending request', () => {
  assert.throws(() => submitResult({ accepted: true, execution: result }))
  assert.throws(() => submitResult({ accepted: false, submission_id: null, submitted_at: null, execution: { ...result, results: null } }))
  assert.equal(submitResult({ accepted: false, submission_id: null, submitted_at: null, execution: result }).accepted, false)
  assert.throws(() => submissionStatus({ can_submit: true }))
  assert.equal(execution({ ...result, results: [{ name: 'test', passed: false, error: 'Sanitized execution feedback' }] }).results[0].error, 'Sanitized execution feedback')
})
test('only terminal errors remove saved actions, service errors retain them even with 422', () => {
  assert.equal(terminalSubmissionError({ status: 409, code: 'SUBMISSION_LIMIT_REACHED' }), true)
  assert.equal(terminalSubmissionError({ status: 422, code: 'INVALID_REQUEST' }), true)
  for (const code of ['EXECUTION_SERVICE_ERROR', 'SUBMISSION_SAVE_FAILED', 'SUBMISSION_PROCESSING', 'IDEMPOTENCY_KEY_REUSED', undefined]) assert.equal(terminalSubmissionError({ status: 422, code }), false)
})

test('detailed execution preserves Unicode, nulls, tracebacks and optional diagnostics', () => {
  const full = { ...result, score: 0, passed: 0, ran: 1, failed: 1, duration_ms: 1.5, stdout: 'hello\0世界\n', stdout_truncated: true, tests: [{ index: 0, name: 'test', display_name: '<b>case</b>', status: 'failed', passed: false, duration_ms: 1, inputs: '', expected: '2', actual: '0', error_type: 'ValueError', error_message: 'bad', traceback: [{ line: 2, function: 'add', code: 'raise ValueError()' }], stdout: 'test output', stdout_truncated: false }] }
  assert.deepEqual(execution(full), full)
  for (const patch of [{ tests: null }, { stdout: 1 }, { ran: 0 }, { failed: 0 }, { duration_ms: -1 }, { syntax_error: { error_type: 'SyntaxError', line: '2' } }, { tests: [{ ...full.tests[0], traceback: [{ line: 2, function: {}, code: 'x' }] }] }]) assert.throws(() => execution({ ...full, ...patch }))
  assert.throws(() => execution({ ...result, tests: [] }))
  const syntax = { ...full, status: 'syntax_error', total: 0, ran: 0, failed: 0, results: [], tests: [], syntax_error: { error_type: 'SyntaxError', line: 1, code_line: 'if', error_message: 'invalid syntax' } }
  assert.deepEqual(execution(syntax), syntax)
  assert.deepEqual(execution(result), result)
})

test('submission recovery preserves mode and upgrades historical records to ordinary submit', () => {
  const store = storage()
  const saved = beginSubmission('student', 'lab', 'unfinished\n', true, store)
  assert.equal(pendingSubmissions('student', 'lab', store)[0].submit_anyway, true)
  const key = `final-submission:student:lab:${saved.key}`
  store.setItem(key, JSON.stringify({ key: saved.key, code: saved.code }))
  assert.equal(pendingSubmissions('student', 'lab', store)[0].submit_anyway, false)
  store.setItem(key, JSON.stringify({ ...saved, submit_anyway: 'true' }))
  assert.throws(() => pendingSubmissions('student', 'lab', store))
})
test('new saved failures are pending review, historical replies remain valid, malformed metadata is rejected', () => {
  const failing = { status: 'syntax_error', results: [], score: 0, passed: 0, total: 0 }
  const saved = { accepted: true, submission_id: 'final', submitted_at: '2026-11-28T10:00:00Z', execution: failing, submit_anyway: true, submission_status: 'pending_review' }
  assert.equal(submitResult(saved).submission_status, 'pending_review')
  for (const patch of [{ submit_anyway: false }, { submit_anyway: 'true' }, { submission_status: 'passed' }, { submission_status: undefined }]) assert.throws(() => submitResult({ ...saved, ...patch }))
  assert.equal(submitResult({ ...saved, execution: result, submission_status: 'passed' }).submission_status, 'passed')
  assert.equal(submitResult({ accepted: true, submission_id: 'old', submitted_at: saved.submitted_at, execution: result }).accepted, true)
})
