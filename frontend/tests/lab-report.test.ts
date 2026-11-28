import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labReport, studentReport, submissionStatus } from '../src/lib/submission-contract.ts'

const integrity = { score: 100, penalty: 0, penalties: { paste: 0, large_insert: 0, focus: 0, fast_pass: 0 }, badge: 'green', flags: [], focus_losses: 0, telemetry_status: 'recorded' }
const execution = { status: 'ok', score: 100, passed: 1, total: 1, results: [{ name: 'Test 1', passed: true, error: null }] }
const timestamp = '2026-11-28T10:00:00Z'
const accepted = { submission_id: 'final', submitted_at: timestamp, version: 1, code_sha256: 'a'.repeat(64), execution }
const student = { student_id: 'student', email: 'student@example.com', full_name: null, enrolled: true, first_pass_at: timestamp, practice_attempt_count: 1, accepted_submission_count: 1, remaining_submissions: 1, accepted_submission: accepted, integrity_scope: 'current_lab', integrity,
  events: [{ event_id: 'event', session_id: 'session', type: 'lab_opened', payload: {}, client_ts: null, received_at: timestamp }],
  submissions: [{ id: 'practice', status: 'ok', score: 100, passed: 1, total: 1, created_at: timestamp, kind: 'practice', version: null, code_sha256: null }, { id: 'final', status: 'ok', score: 100, passed: 1, total: 1, created_at: timestamp, kind: 'final', version: 1, code_sha256: 'a'.repeat(64) }] }
const report = { lab_id: 'lab', title: 'Python', max_submissions: 2, allow_resubmissions: true, students: [student] }

test('lab report policy belongs to the lab, not each student row', () => {
  assert.deepEqual(labReport(report), report)
  assert.equal(labReport({ ...report, max_submissions: null, students: [{ ...student, remaining_submissions: null }] }).students[0].remaining_submissions, null)
  assert.equal(labReport({ ...report, students: [{ ...student, first_pass_at: null, accepted_submission: null, accepted_submission_count: 0, submissions: [], events: [] }] }).students[0].accepted_submission, null)
})
test('lab report still validates policy, history and integrity', () => {
  assert.throws(() => labReport({ ...report, max_submissions: undefined }))
  assert.throws(() => labReport({ ...report, students: [{ ...student, accepted_submission_count: undefined }] }))
  assert.throws(() => labReport({ ...report, students: [{ ...student, integrity: {} }] }))
  assert.throws(() => labReport({ ...report, students: [{ ...student, accepted_submission: { ...accepted, execution: {} } }] }))
})
test('status and course-student reports still require their own lab policies', () => {
  assert.throws(() => submissionStatus({ ...student, lab_id: 'lab', can_submit: true }))
  const lab = { ...student, lab_id: 'lab', title: 'Python', max_submissions: 2, allow_resubmissions: true }
  const course = { course_id: 'course', student: { id: 'student', email: student.email, full_name: null }, labs: [lab] }
  assert.equal(studentReport(course).labs.length, 1)
  assert.throws(() => studentReport({ ...course, labs: [{ ...lab, max_submissions: undefined }] }))
})
