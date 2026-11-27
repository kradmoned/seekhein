import assert from "node:assert/strict"
import { randomUUID, webcrypto, createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"
import ts from "typescript"

const guide = readFileSync(new URL("../docs/frontend-final-submissions.md", import.meta.url), "utf8")
const transport = guide.match(/```ts\n(type PendingSubmission[\s\S]*?)\n```/)[1]
const hashing = guide.match(/```ts\n(async function codeDigest[\s\S]*?)\n\nconst snapshot/)[1]
function harness() {
  const storage = new Map()
  let response = { status: 200, body: { accepted: true } }
  const requests = []
  const context = vm.createContext({
    crypto: { randomUUID, subtle: webcrypto.subtle }, TextEncoder,
    localStorage: { setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    fetch: async (_url, init) => {
      requests.push(init)
      if (response instanceof Error) throw response
      return Response.json(response.body, { status: response.status })
    },
  })
  for (const source of [transport, hashing]) vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context)
  return { context, storage, requests, setResponse: (value) => { response = value } }
}
test("frontend retry preserves code/key and retains uncertain actions", async () => {
  const h = harness()
  const pending = h.context.beginSubmission("student", "lab", "exact code\n")
  h.setResponse({ status: 409, body: { code: "SUBMISSION_PROCESSING" } })
  await h.context.sendSubmission("student", "lab", pending, async () => "token")
  assert.equal(h.storage.size, 1)
  h.setResponse(new Error("lost response"))
  await assert.rejects(h.context.sendSubmission("student", "lab", pending, async () => "token"))
  assert.equal(h.storage.size, 1)
  h.setResponse({ status: 200, body: { accepted: true } })
  await h.context.sendSubmission("student", "lab", pending, async () => "token")
  assert.equal(h.storage.size, 0)
  assert.ok(h.requests.every((r) => r.headers["Idempotency-Key"] === pending.key && JSON.parse(r.body).code === pending.code))
})
test("separate pending keys do not overwrite each other", async () => {
  const h = harness()
  const first = h.context.beginSubmission("student", "lab", "one")
  h.context.beginSubmission("student", "lab", "two")
  assert.equal(h.storage.size, 2)
  h.setResponse({ status: 200, body: { accepted: false } })
  await h.context.sendSubmission("student", "lab", first, async () => "token")
  assert.equal(h.storage.size, 1)
})
test("Submit anyway uses a new key and preserves its mode through recovery", async () => {
  const h = harness()
  const regular = h.context.beginSubmission("student", "lab", "unfinished code")
  const anyway = h.context.beginSubmission("student", "lab", "unfinished code", true)
  assert.notEqual(anyway.key, regular.key)
  h.setResponse({ status: 500, body: { code: "SUBMISSION_SAVE_FAILED" } })
  await h.context.sendSubmission("student", "lab", anyway, async () => "token")
  const recovered = [...h.storage.values()].map(JSON.parse).find((p) => p.key === anyway.key)
  assert.equal(recovered.submit_anyway, true)
  h.setResponse({ status: 200, body: { accepted: true, submission_status: "pending_review" } })
  await h.context.sendSubmission("student", "lab", recovered, async () => "token")
  assert.equal(h.storage.size, 1)
  for (const request of h.requests) {
    assert.equal(request.headers["Idempotency-Key"], anyway.key)
    assert.deepEqual(JSON.parse(request.body), { code: anyway.code, submit_anyway: true })
  }
})
test("historical pending actions recover using ordinary submission mode", async () => {
  const h = harness()
  await h.context.sendSubmission("student", "lab", { key: randomUUID(), code: "pass" }, async () => "token")
  assert.deepEqual(JSON.parse(h.requests[0].body), { code: "pass", submit_anyway: false })
})
test("a terminal numeric-limit rejection clears only its pending action", async () => {
  const h = harness()
  const pending = h.context.beginSubmission("student", "lab", "one")
  h.context.beginSubmission("student", "lab", "two")
  h.setResponse({ status: 409, body: { code: "SUBMISSION_LIMIT_REACHED" } })
  await h.context.sendSubmission("student", "lab", pending, async () => "token")
  assert.equal(h.storage.size, 1)
})
test("frontend digest matches server SHA-256 for exact UTF-8 source", async () => {
  const h = harness()
  for (const code of ["pass\n", "print('سلام')\r\n", "# 😀\n"]) {
    assert.equal(await h.context.codeDigest(code), createHash("sha256").update(code, "utf8").digest("hex"))
  }
})
