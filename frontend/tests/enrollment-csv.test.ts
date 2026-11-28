import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enrollmentCsv } from '../src/lib/enrollment-csv.ts'

test('CSV handles BOM, CRLF, quoted commas and duplicate emails', () => {
  const result = enrollmentCsv('\uFEFFname,email\r\n"Doe, Jane",jane@example.com\r\n"Sam ""S""",sam@example.com\r\nJane,JANE@example.com\r\n')
  assert.deepEqual(result, { emails: ['jane@example.com', 'sam@example.com'], duplicates: 1, errors: [] })
})
test('CSV validates structure, limits, and emails before import', () => {
  for (const source of ['', 'name\nJane', 'email,email\na@b.com,a@b.com', 'email\n', 'email\n"unclosed', 'email\n"a@b.com"unexpected', 'email\n' + 'a@b.com\n'.repeat(201)]) assert.throws(() => enrollmentCsv(source))
  assert.equal(enrollmentCsv('email\nbad\nvalid@example.com').errors.length, 1)
  assert.equal(enrollmentCsv('name,email\nOnly one column').errors.length, 1)
})
