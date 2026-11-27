import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"
import ts from "typescript"

class HttpError extends Error { constructor(status, message) { super(message); this.status = status } }
const exports = {}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/submission-policy.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports, require: () => ({ HttpError }) })
const { validateSubmissionLimit, readUploadSubmissionLimit } = exports

test("JSON limits accept positive PostgreSQL integers or null only", () => {
  for (const value of [1, 2, 3, 2147483647, null]) assert.equal(validateSubmissionLimit(value), value)
  for (const value of [undefined, 0, -1, 1.5, "2", true, NaN, Infinity, 2147483648]) {
    assert.throws(() => validateSubmissionLimit(value), { status: 422 })
  }
})
test("multipart limits validate text, duplicates, legacy settings and conflicts", () => {
  for (const [fields, expected] of [
    [[['max_submissions', '1']], 1], [[['max_submissions', '3']], 3],
    [[['max_submissions', 'unlimited']], null], [[['allow_resubmissions', 'false']], 1],
    [[['allow_resubmissions', 'true']], null], [[['max_submissions', '2'], ['allow_resubmissions', 'true']], 2],
  ]) {
    const form = new FormData()
    for (const [key, value] of fields) form.append(key, value)
    assert.equal(readUploadSubmissionLimit(form), expected)
  }
  const bad = ['', '0', '-1', '1.5', '01', ' 2', '2 ', '1e2', 'null', '2147483648', new File(['2'], 'limit.txt')]
  for (const value of bad) {
    const form = new FormData(); form.append('max_submissions', value)
    assert.throws(() => readUploadSubmissionLimit(form), { status: 422 })
  }
  for (const fields of [[], [['max_submissions', '2'], ['max_submissions', '3']], [['max_submissions', '2'], ['allow_resubmissions', 'false']], [['max_submissions', '1'], ['allow_resubmissions', 'true']]]) {
    const form = new FormData()
    for (const [key, value] of fields) form.append(key, value)
    assert.throws(() => readUploadSubmissionLimit(form), { status: 422 })
  }
})
