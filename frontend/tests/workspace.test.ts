import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftKey, readDraft, writeDraft, validateCode, executionPassed } from '../src/lib/workspace.ts'

test('UTF-8 limits count bytes and preserve the boundary', () => {
  assert.equal(validateCode('é'.repeat(32768)), '')
  assert.match(validateCode('é'.repeat(32769)), /65,536/)
  assert.match(validateCode(' \n\t'), /Enter/)
})
test('success requires ok and at least one test', () => {
  const result = { status: 'ok' as const, total: 1, passed: 1, score: 100, results: [] }
  assert.equal(executionPassed(result), true)
  assert.equal(executionPassed({ ...result, total: 0, passed: 0 }), false)
  assert.equal(executionPassed({ ...result, status: 'timeout' }), false)
})
test('empty drafts survive and storage failure retains edits across remounts', () => {
  const storage = { getItem: () => null, setItem: () => { throw Error('quota') } }
  const key = draftKey('student-a', 'lab-a')
  assert.throws(() => writeDraft(key, '', storage))
  assert.equal(readDraft(key, 'starter', storage), '')
  assert.equal(readDraft(draftKey('student-b', 'lab-a'), 'other', storage), 'other')
  assert.equal(readDraft(draftKey('student-a', 'lab-b'), 'other lab', storage), 'other lab')
})
