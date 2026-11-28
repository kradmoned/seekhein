import { test } from 'node:test'
import assert from 'node:assert/strict'
import { courseBody, enrollmentBody, courseUpload } from '../src/lib/course-contract.ts'

test('course fields are trimmed, bounded, and exact', () => {
  assert.deepEqual(JSON.parse(courseBody(' Python ')), { title: 'Python', description: '' })
  assert.doesNotThrow(() => courseBody('a'.repeat(200), 'a'.repeat(5000)))
  assert.throws(() => courseBody('   '))
  assert.throws(() => courseBody('a'.repeat(201)))
  assert.throws(() => courseBody('Python', 'a'.repeat(5001)))
})
test('JSON size uses UTF-8 bytes including escaped characters', () => {
  assert.throws(() => courseBody('Python', '😀'.repeat(4500)), /16 KiB/)
  assert.throws(() => courseBody('Python', '\u0001'.repeat(3000)), /16 KiB/)
  assert.throws(() => enrollmentBody('é'.repeat(8192)), /16 KiB/)
  assert.deepEqual(JSON.parse(enrollmentBody(' Student@example.com ')), { email: 'Student@example.com' })
})
test('upload includes exactly one course id and preserves existing files', () => {
  const form = new FormData()
  form.append('course_id', 'old')
  form.append('course_id', 'duplicate')
  form.append('title', 'Lab')
  form.append('starter', new Blob(['print(1)']), 'starter.py')
  const file = form.get('starter')
  courseUpload('course-id', form)
  assert.deepEqual(form.getAll('course_id'), ['course-id'])
  assert.equal(form.get('title'), 'Lab')
  assert.equal(form.get('starter'), file)
})
