import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { test } from "node:test"
import ts from "typescript"

const root = fileURLToPath(new URL("../", import.meta.url))
const id = "11111111-1111-4111-8111-111111111111"
const secret = "PRIVATE_TEACHER_TEST"
const source = "def add(a, b):\r\n    return a + b\r\n"
const suite = "import unittest\nfrom solution import add\nclass T(unittest.TestCase):\n    def test_a(self): self.assertEqual(add(1, 2), 3)\n"
function validResult() {
  return {
    valid: true, status: "ok", summary: "All tests passed", duration_ms: 2,
    total_tests: 1, ran_tests: 1, passed_tests: 1, failed_tests: 0,
    tests: [{ index: 1, name: "test_a", display_name: secret, status: "passed", passed: true, duration_ms: 1 }],
    warnings: ["Test lacks a docstring label"],
  }
}
function harness(options = {}) {
  const calls = [], queries = [], cache = new Map()
  function load(relative) {
    const filename = path.resolve(root, relative)
    if (filename.endsWith("/lib/auth.ts")) return { requireUser: async () => {
      if (options.role === "anonymous") return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) }
      if (options.role === "student") return { error: Response.json({ error: "Forbidden" }, { status: 403 }) }
      return { user: { id, role: "teacher" } }
    } }
    if (filename.endsWith("/lib/db.ts")) return { pool: { query: async (sql, values) => {
      queries.push({ sql, values })
      if (sql.includes("INSERT INTO public.labs")) {
        if (options.saveError) throw new Error(secret)
        return { rows: options.accessLost ? [] : [{ id, validated_at: new Date("2026-11-27T12:00:00Z") }] }
      }
      return { rows: options.inaccessible ? [] : [{ id, teacher_id: id }] }
    } } }
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}; cache.set(filename, exports)
    const source = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText
    vm.runInNewContext(source, {
      exports, Request, Response, File, URL, Buffer, TextDecoder,
      AbortSignal: options.abortSignal ?? AbortSignal, console: { error() {} },
      process: { env: { RUNNER_URL: "http://runner.test", RUNNER_INTERNAL_KEY: "server-key", ...options.env } },
      fetch: async (url, init) => {
        calls.push({ url: String(url), ...init })
        return options.fetch ? options.fetch() : Response.json(options.result ?? validResult(), { status: options.httpStatus ?? 200 })
      },
      require: (name) => load(path.resolve(path.dirname(filename), `${name}.ts`)),
    }, { filename })
    return exports
  }
  const route = load("app/api/labs/route.ts")
  return {
    calls, queries,
    upload: (edit = () => {}) => {
      const form = new FormData()
      form.set("course_id", id); form.set("title", "Addition"); form.set("max_submissions", "3")
      for (const [name, content] of Object.entries({ instructions: "Add two numbers", starter: "def add(a,b): pass\n", tests: suite, solution: source })) {
        form.set(name, new File([content], `${name}.txt`))
      }
      edit(form)
      return route.POST(new Request("http://localhost/api/labs", { method: "POST", headers: { Authorization: "Bearer browser-secret" }, body: form }))
    },
  }
}
const saved = (h) => h.queries.filter((q) => q.sql.includes("INSERT INTO public.labs"))

test("upload validates exact files, saves the matching source and compact audit, and returns warnings", async () => {
  const h = harness()
  const response = await h.upload()
  assert.equal(response.status, 201)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const body = await response.json()
  assert.equal(body.id, id)
  assert.equal(body.validated_at, "2026-11-27T12:00:00.000Z")
  assert.equal(body.validation.valid, true)
  assert.deepEqual(body.validation.warnings, ["Test lacks a docstring label"])
  assert.equal(h.calls[0].url, "http://runner.test/validate")
  assert.deepEqual(JSON.parse(h.calls[0].body), { solution: source, tests: suite })
  assert.equal(h.calls[0].headers.Authorization, undefined)
  assert.equal(h.calls[0].headers["X-Internal-Key"], "server-key")
  assert.equal(h.calls[0].redirect, "error")
  assert.equal(saved(h)[0].values[4], suite)
  assert.equal(saved(h)[0].values[5], source)
  assert.deepEqual(JSON.parse(saved(h)[0].values[9]), body.validation)
  assert.ok(!JSON.stringify(body).includes(secret))
})

test("failed assertions return teacher diagnostics and never insert a lab", async () => {
  const result = validResult()
  result.valid = false; result.passed_tests = 0; result.failed_tests = 1
  Object.assign(result.tests[0], { status: "failed", passed: false, expected: "3", actual: "-1", full_traceback: secret, untrusted_extra: secret })
  const h = harness({ result, httpStatus: 422 })
  const response = await h.upload()
  assert.equal(response.status, 422)
  const body = await response.json()
  assert.equal(body.code, "LAB_VALIDATION_FAILED")
  assert.equal(body.validation.tests[0].full_traceback, secret)
  assert.equal(body.validation.tests[0].untrusted_extra, undefined)
  assert.equal(saved(h).length, 0)
})

for (const status of ["ok", "syntax_error", "runtime_error", "timeout", "oom"]) {
  test(`${status} with zero tests never saves`, async () => {
    const result = { ...validResult(), valid: false, status, total_tests: 0, ran_tests: 0, passed_tests: 0, failed_tests: 0, tests: [] }
    if (status === "syntax_error") result.syntax_error = { source: "tests", error_type: "SyntaxError", line: 2, code_line: "bad code" }
    const h = harness({ result, httpStatus: 422 })
    const response = await h.upload()
    assert.equal(response.status, 422)
    const body = await response.json()
    assert.equal(body.code, "LAB_VALIDATION_FAILED")
    if (status === "syntax_error") assert.equal(body.validation.syntax_error.source, "tests")
    assert.equal(saved(h).length, 0)
  })
}

test("auth and course ownership prevent runner calls and lab writes", async () => {
  for (const [options, status] of [[{ role: "anonymous" }, 401], [{ role: "student" }, 403], [{ inaccessible: true }, 404]]) {
    const h = harness(options)
    assert.equal((await h.upload()).status, status)
    assert.equal(h.calls.length, 0)
    assert.equal(saved(h).length, 0)
  }
})

test("invalid/oversized files are rejected before execution, with UTF-8 byte limits", async () => {
  for (const [field, bytes, status] of [
    ["solution", "é".repeat(32769), 413], ["tests", "x".repeat(65537), 413],
    ["starter", "x".repeat(65537), 413], ["instructions", "x".repeat(1048577), 413],
    ["tests", " ", 422], ["solution", new Uint8Array([255]), 422], ["solution", "\0", 422],
  ]) {
    const h = harness()
    assert.equal((await h.upload((form) => form.set(field, new File([bytes], "file.txt")))).status, status)
    assert.equal(h.calls.length, 0)
    assert.equal(saved(h).length, 0)
  }
})

test("malformed and inconsistent runner results fail closed", async () => {
  const mutations = [
    (r) => { r.valid = false }, (r) => { r.total_tests = 0 }, (r) => { r.ran_tests = 0 },
    (r) => { r.passed_tests = 0 }, (r) => { r.failed_tests = 1 }, (r) => { r.tests[0].passed = false },
    (r) => { r.status = "internal_error" }, (r) => { r.warnings = "bad" }, (r) => { r.tests[0].duration_ms = -1 },
  ]
  for (const mutate of mutations) {
    const result = validResult(); mutate(result)
    const h = harness({ result })
    const response = await h.upload()
    assert.equal(response.status, 502)
    assert.equal((await response.json()).code, "LAB_VALIDATION_SERVICE_ERROR")
    assert.equal(saved(h).length, 0)
  }
  const h = harness({ result: validResult(), httpStatus: 422 })
  assert.equal((await h.upload()).status, 502)
  const badStatus = harness({ httpStatus: 422, result: {
    ...validResult(), valid: false, status: ["syntax_error"], total_tests: 0,
    ran_tests: 0, passed_tests: 0, failed_tests: 0, tests: [],
  } })
  assert.equal((await badStatus.upload()).status, 502)
})

test("serialized validation payload size is bounded even when both files fit", async () => {
  const h = harness()
  const response = await h.upload((form) => {
    for (const field of ["solution", "tests"]) form.set(field, new File(["\u0001".repeat(65536)], `${field}.py`))
  })
  assert.equal(response.status, 413)
  assert.equal(h.calls.length, 0)
  assert.equal(saved(h).length, 0)
})

test("runner infrastructure errors never forward raw bodies or save labs", async () => {
  for (const [upstream, expected] of [[429,429],[503,503],[500,502],[400,502],[413,413],[302,502]]) {
    const h = harness({ fetch: () => new Response(secret, { status: upstream }) })
    const response = await h.upload()
    assert.equal(response.status, expected)
    assert.ok(!(await response.text()).includes(secret))
    assert.equal(saved(h).length, 0)
  }
  for (const fetch of [() => { throw new Error(secret) }, () => new Response("{"), () => new Response("x".repeat(1048577))]) {
    const h = harness({ fetch })
    assert.equal((await h.upload()).status, 502)
    assert.equal(saved(h).length, 0)
  }
  const h = harness({ abortSignal: { timeout: () => ({ aborted: true }) }, fetch: () => { throw new Error(secret) } })
  assert.equal((await h.upload()).status, 504)
})

test("ownership loss or database failure after validation never returns upload success", async () => {
  for (const [options, status] of [[{ accessLost: true }, 404], [{ saveError: true }, 500]]) {
    const h = harness(options)
    const response = await h.upload()
    assert.equal(response.status, status)
    assert.equal(h.calls.length, 1)
    assert.ok(!(await response.text()).includes(secret))
  }
})
