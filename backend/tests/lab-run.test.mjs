import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import ts from "typescript"

const root = fileURLToPath(new URL("../", import.meta.url))
const labId = "11111111-1111-4111-8111-111111111111"
const code = "def add(a, b):\n    return a + b\n"
const tests = "import unittest\nfrom solution import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n"
const secret = "HIDDEN_TEST_SENTINEL"

// Load the real TypeScript handlers using the existing compiler. Only network,
// auth, and database boundaries are replaced; no test dependency is needed.
function harness(options = {}) {
  const queries = []
  const requests = []
  const authRoles = []
  const cache = new Map()
  const globals = {
    Request, Response, URL, Buffer, TextDecoder,
    AbortSignal: options.abortSignal ?? AbortSignal,
    console: { error() {} },
    process: { env: { RUNNER_URL: "http://runner.test:8081", ...options.env } },
    fetch: async (url, init) => {
      requests.push({ url: String(url), ...init })
      if (options.fetch) return options.fetch(url, init)
      return Response.json(options.result ?? runnerResult())
    },
  }
  function load(relative) {
    const filename = path.resolve(root, relative)
    if (filename === path.join(root, "lib/auth.ts")) {
      return { requireUser: async (_req, role) => {
        authRoles.push(role)
        return options.authError ? { error: options.authError } : { user: { id: labId, role: "student" } }
      } }
    }
    if (filename === path.join(root, "lib/db.ts")) {
      return { pool: { query: async (sql, values) => {
        queries.push({ sql, values })
        if (options.dbError) throw new Error(secret)
        return { rows: options.rows ?? [{ tests }] }
      } } }
    }
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}
    cache.set(filename, exports)
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText
    vm.runInNewContext(source, {
      ...globals, exports,
      require: (name) => load(path.resolve(path.dirname(filename), `${name}.ts`)),
    }, { filename })
    return exports
  }
  const route = load("app/api/labs/[id]/run/route.ts")
  return {
    route, queries, requests, authRoles,
    run: (body = { code }, id = labId, contentType = "application/json") => route.POST(
      new Request(`http://localhost/api/labs/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": contentType, Authorization: "Bearer browser-token" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  }
}

function runnerResult() {
  return {
    status: "ok", score: 50, passed: 1, failed: 1, ran: 2, total: 2,
    stdout: secret, internal_error: secret, syntax_error: { code_line: secret },
    tests: [
      { name: secret, display_name: secret, status: "passed", passed: true, expected: secret, inputs: secret, actual: secret, stdout: secret },
      { name: secret, status: "failed", passed: false, error_message: secret, traceback: [{ code: secret }], detail: secret },
    ],
  }
}

test("run uses editor code and full database tests, then returns only safe fields", async () => {
  const h = harness({ env: { RUNNER_INTERNAL_KEY: "server-test-key" } })
  const response = await h.run()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  assert.deepEqual(await response.json(), {
    status: "ok", score: 50, passed: 1, total: 2,
    results: [
      { name: "Test 1", passed: true, error: null },
      { name: "Test 2", passed: false, error: "Test failed" },
    ],
  })
  assert.equal(h.route.runtime, "nodejs")
  assert.deepEqual(h.authRoles, [undefined])
  assert.match(h.queries[0].sql, /SELECT l.tests FROM public.labs l/)
  assert.match(h.queries[0].sql, /JOIN public.courses/)
  assert.match(h.queries[0].sql, /public.course_enrollments/)
  assert.equal(JSON.stringify(h.queries[0].values), JSON.stringify([labId, "student", labId]))
  assert.equal(h.requests[0].url, "http://runner.test:8081/run?view=student")
  assert.deepEqual(JSON.parse(h.requests[0].body), { code, tests })
  assert.equal(h.requests[0].headers["X-Internal-Key"], "server-test-key")
  assert.equal(h.requests[0].headers.Authorization, undefined)
  assert.equal(h.requests[0].redirect, "error")
})

test("authentication runs before parsing, querying, or running code", async () => {
  const h = harness({ authError: Response.json({ error: "Unauthorized" }, { status: 401 }) })
  assert.equal((await h.run("not JSON", "invalid")).status, 401)
  assert.equal(h.queries.length, 0)
  assert.equal(h.requests.length, 0)
})

for (const [name, body, id, contentType, status] of [
  ["bad lab ID", { code }, "invalid", "application/json", 400],
  ["wrong content type", { code }, labId, "text/plain", 415],
  ["invalid JSON", "{", labId, "application/json", 400],
  ["null body", "null", labId, "application/json", 422],
  ["array body", [], labId, "application/json", 422],
  ["missing code", {}, labId, "application/json", 422],
  ["non-string code", { code: 123 }, labId, "application/json", 422],
  ["empty code", { code: " \n " }, labId, "application/json", 422],
  ["browser-supplied tests", { code, tests: "assert True" }, labId, "application/json", 422],
  ["browser-supplied view", { code, view: "tutor" }, labId, "application/json", 422],
  ["code exceeds byte limit", { code: "é".repeat(32769) }, labId, "application/json", 413],
  ["oversized request without Content-Length", " ".repeat(512 * 1024 + 1), labId, "application/json", 413],
]) {
  test(`rejects ${name} before database access`, async () => {
    const h = harness()
    assert.equal((await h.run(body, id, contentType)).status, status)
    assert.equal(h.queries.length, 0)
    assert.equal(h.requests.length, 0)
  })
}

test("unknown lab returns 404 without contacting runner", async () => {
  const h = harness({ rows: [] })
  assert.equal((await h.run()).status, 404)
  assert.equal(h.requests.length, 0)
})

test("database failures are generic and do not reach runner", async () => {
  const h = harness({ dbError: true })
  const response = await h.run()
  assert.equal(response.status, 500)
  assert.doesNotMatch(await response.text(), new RegExp(secret))
  assert.equal(h.requests.length, 0)
})

test("stored test file above 64 KiB is rejected intact", async () => {
  const h = harness({ rows: [{ tests: "x".repeat(65537) }] })
  assert.equal((await h.run()).status, 422)
  assert.equal(h.requests.length, 0)
})

for (const value of ["", "not-a-url", "ftp://runner.test", "http://runner.test?view=tutor", "http://runner.test/run"]) {
  test(`invalid runner origin is handled without a network call: ${value}`, async () => {
    const h = harness({ env: { RUNNER_URL: value } })
    assert.equal((await h.run()).status, 503)
    assert.equal(h.requests.length, 0)
  })
}

for (const [upstream, expected] of [[400, 502], [401, 502], [413, 502], [429, 429], [500, 502], [503, 503]]) {
  test(`upstream HTTP ${upstream} maps to ${expected} with no upstream error text`, async () => {
    const h = harness({ fetch: async () => Response.json({ error: secret }, { status: upstream }) })
    const response = await h.run()
    assert.equal(response.status, expected)
    assert.doesNotMatch(await response.text(), new RegExp(secret))
  })
}

for (const status of ["syntax_error", "runtime_error", "timeout", "oom", "internal_error", "ok"]) {
  test(`handles runner status ${status} without leaked diagnostics`, async () => {
    const result = { ...runnerResult(), status, score: 0, passed: 0, failed: 0, ran: 0, total: 0, tests: [] }
    const h = harness({ result })
    const response = await h.run()
    assert.equal(response.status, status === "internal_error" ? 502 : status === "ok" ? 422 : 200)
    assert.doesNotMatch(await response.text(), new RegExp(secret))
  })
}

for (const result of [null, {}, { ...runnerResult(), score: 100 }, { ...runnerResult(), total: 3 }, { ...runnerResult(), status: secret }]) {
  test("malformed or inconsistent runner result fails closed", async () => {
    const h = harness({ fetch: async () => Response.json(result) })
    const response = await h.run()
    assert.equal(response.status, 502)
    assert.doesNotMatch(await response.text(), new RegExp(secret))
  })
}

test("non-JSON runner response is handled", async () => {
  const h = harness({ fetch: async () => new Response(secret) })
  assert.equal((await h.run()).status, 502)
})

test("runner response size is bounded", async () => {
  const h = harness({ fetch: async () => new Response("x".repeat(1024 * 1024 + 1)) })
  assert.equal((await h.run()).status, 502)
})

test("runner network failure returns a generic 502", async () => {
  const h = harness({ fetch: async () => { throw new Error(secret) } })
  const response = await h.run()
  assert.equal(response.status, 502)
  assert.doesNotMatch(await response.text(), new RegExp(secret))
})

test("30-second deadline covers the complete runner request", async () => {
  const signal = { aborted: false }
  const h = harness({
    abortSignal: { timeout(ms) { assert.equal(ms, 30_000); return signal } },
    fetch: async () => { signal.aborted = true; throw new Error("aborted") },
  })
  assert.equal((await h.run()).status, 504)
})
