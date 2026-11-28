import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uploadSuccess, labValidation } from '../src/lib/lab-validation.ts'

test('upload success validates server audit and nonblocking warnings', () => {
  const value = { id: 'lab', validated_at: '2026-11-28T10:00:00Z', validation: { valid: true, status: 'ok', total_tests: 1, passed_tests: 1, warnings: ['<b>Missing label</b>'] } }
  assert.deepEqual(uploadSuccess(value), value)
  assert.throws(() => uploadSuccess({ id: 'lab' }))
  assert.throws(() => uploadSuccess({ ...value, validation: { ...value.validation, total_tests: 0 } }))
})
test('teacher syntax diagnostics preserve text and reject malformed fields', () => {
  const value = { valid: false, summary: 'Invalid syntax', status: 'syntax_error', duration_ms: 2, total_tests: 0, ran_tests: 0, passed_tests: 0, failed_tests: 0, tests: [], warnings: [], syntax_error: { source: 'tests', error_type: 'SyntaxError', line: 3, code_line: '<script>not HTML</script>' } }
  assert.deepEqual(labValidation(value), value)
  assert.throws(() => labValidation({ ...value, syntax_error: { ...value.syntax_error, line: 'three' } }))
  assert.throws(() => labValidation({ ...value, warnings: [{}] }))
})
