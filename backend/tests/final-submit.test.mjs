import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import ts from "typescript"

const root = fileURLToPath(new URL("../", import.meta.url))
const labId = "11111111-1111-4111-8111-111111111111"
const key = "22222222-2222-4222-8222-222222222222"
function harness(role = "student") {
  const cache = new Map()
  const calls = []
  function load(relative) {
    const filename = path.resolve(root, relative)
    if (filename.endsWith("/lib/auth.ts")) return { requireUser: async (_req, required) => role === required ? { user: { id: labId, role } } : { error: Response.json({ error: "Forbidden" }, { status: 403 }) } }
    if (filename.endsWith("/lib/final-submissions.ts")) {
      const { HttpError } = load("lib/http.ts")
      class SubmissionError extends HttpError {
        constructor(status, code, message) { super(status, message); this.code = code }
      }
      return { SubmissionError, submitFinal: async (...args) => { calls.push(args); return { http_status: 200, body: { accepted: false } } } }
    }
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}
    cache.set(filename, exports)
    const source = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
    vm.runInNewContext(source, { exports, Response, Request, Buffer, TextDecoder, console, require: (name) => load(path.resolve(path.dirname(filename), `${name}.ts`)) })
    return exports
  }
  const route = load("app/api/labs/[id]/submit/route.ts")
  return {
    calls,
    send: (body, headers = { "Content-Type": "application/json", "Idempotency-Key": key }, id = labId) => route.POST(
      new Request("http://localhost", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }),
      { params: Promise.resolve({ id }) },
    ),
  }
}
test("Submit validates source before invoking final execution", async () => {
  for (const [body, status] of [
    ["{", 400], [null, 422], [{ code: " " }, 422], [{ code: "pass", tests: "secret" }, 422],
    [{ code: "é".repeat(32769) }, 413], [" ".repeat(524289), 413],
    [{ code: "\0" }, 422], [{ code: "\ud800" }, 422],
    [{ code: "pass", submit_anyway: "true" }, 422], [{ code: "pass", submit_anyway: 1 }, 422],
    [{ code: "pass", submit_anyway: null }, 422], [{ code: "pass", accepted: true }, 422],
  ]) {
    const h = harness()
    assert.equal((await h.send(body)).status, status)
    assert.equal(h.calls.length, 0)
  }
})
test("Submit forwards exact source and the required key", async () => {
  const h = harness()
  const code = "def add(a,b):\r\n    return a+b\r\n"
  const response = await h.send({ code })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  assert.deepEqual(h.calls[0], [labId, labId, key, code, false])
})
test("Submit anyway forwards an explicit boolean with the exact source", async () => {
  for (const submitAnyway of [true, false]) {
    const h = harness()
    const response = await h.send({ code: "# unfinished\npass\n", submit_anyway: submitAnyway })
    assert.equal(response.status, 200)
    assert.deepEqual(h.calls[0], [labId, labId, key, "# unfinished\npass\n", submitAnyway])
  }
})
test("Submit rejects teacher requests before validation", async () => {
  const h = harness("teacher")
  assert.equal((await h.send("bad")).status, 403)
  assert.equal(h.calls.length, 0)
})
test("Submit requires a JSON content type", async () => {
  const h = harness()
  assert.equal((await h.send({ code: "pass" }, { "Content-Type": "text/plain", "Idempotency-Key": key })).status, 415)
  assert.equal(h.calls.length, 0)
})

test("Submit validates UUIDs and returns machine-readable key errors", async () => {
  const h = harness()
  for (const value of [undefined, "invalid"]) {
    const headers = { "Content-Type": "application/json" }
    if (value !== undefined) headers["Idempotency-Key"] = value
    const response = await h.send({ code: "pass" }, headers)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, "INVALID_IDEMPOTENCY_KEY")
  }
  const response = await h.send({ code: "pass" }, undefined, "invalid")
  assert.equal((await response.json()).code, "INVALID_LAB_ID")
  assert.equal(h.calls.length, 0)
})
