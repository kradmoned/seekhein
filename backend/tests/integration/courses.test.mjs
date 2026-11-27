import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import pg from "pg"
import ts from "typescript"

const root = fileURLToPath(new URL("../../", import.meta.url))

// Run explicitly against the configured development database. All schema and
// fixture writes are rolled back, including when an assertion fails.
test("course membership protects every lab entry point", { skip: !process.env.DATABASE_URL }, async (t) => {
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  })
  await db.connect()
  let currentUser
  let runnerCalls = 0
  const queries = []
  const cache = new Map()

  function load(relative) {
    const filename = path.resolve(root, relative)
    if (filename === path.join(root, "lib/auth.ts")) {
      return { requireUser: async (_req, role) => {
        if (!currentUser) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) }
        if (role && currentUser.role !== role) return { error: Response.json({ error: "Forbidden" }, { status: 403 }) }
        return { user: currentUser }
      } }
    }
    if (filename === path.join(root, "lib/db.ts")) {
      return { pool: { query: async (sql, values) => {
        queries.push(sql)
        return db.query(sql, values)
      } } }
    }
    if (filename === path.join(root, "lib/runner.ts")) {
      class RunnerError extends Error {}
      return {
        maxSourceBytes: 65536, maxRequestBytes: 524288, RunnerError,
        requestRunner: async () => ({ httpStatus: 200, data: {
          valid: true, status: "ok", summary: "All tests passed", duration_ms: 1,
          total_tests: 1, ran_tests: 1, passed_tests: 1, failed_tests: 0,
          tests: [{ index: 1, name: "test_a", display_name: "Test A", status: "passed", passed: true, duration_ms: 1 }],
        } }),
        runCode: async () => {
          runnerCalls++
          return { status: "ok", results: [{ name: "Test 1", passed: true, error: null }], score: 100, passed: 1, total: 1 }
        },
      }
    }
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}
    cache.set(filename, exports)
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText
    vm.runInNewContext(source, {
      exports, Request, Response, URL, Buffer, File, TextDecoder, console,
      require: (name) => load(path.resolve(path.dirname(filename), `${name}.ts`)),
    }, { filename })
    return exports
  }

  function request(url, body, contentType = "application/json") {
    return new Request(`http://localhost${url}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": contentType },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  const context = (id) => ({ params: Promise.resolve({ id }) })
  const courses = load("app/api/courses/route.ts")
  const detail = load("app/api/courses/[id]/route.ts")
  const students = load("app/api/courses/[id]/students/route.ts")
  const labs = load("app/api/labs/route.ts")
  const labDetail = load("app/api/labs/[id]/route.ts")
  const run = load("app/api/labs/[id]/run/route.ts")
  const eventsRoute = load("app/api/labs/[id]/events/route.ts")
  const reportRoute = load("app/api/labs/[id]/report/route.ts")

  try {
    await db.query("BEGIN")
    await db.query("SET LOCAL lock_timeout = '5s'")
    await db.query("SET LOCAL statement_timeout = '15s'")
    const profiles = (await db.query("SELECT id, email, full_name, role FROM public.profiles ORDER BY id")).rows
    const teacher = profiles.find((p) => p.role === "teacher")
    const learners = profiles.filter((p) => p.role === "student")
    assert.ok(teacher && learners.length >= 2, "Requires one existing teacher and two students")
    const [student, otherStudent] = learners
    const otherTeacher = { id: "00000000-0000-4000-8000-000000000001", role: "teacher" }
    const exists = (await db.query("SELECT to_regclass('public.courses') AS name")).rows[0].name
    if (!exists) {
      const migration = readFileSync(path.join(root, "db/migrations/20261126_001_courses.sql"), "utf8")
      await db.query(migration.replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, ""))
      assert.equal((await db.query("SELECT count(*)::int AS count FROM public.labs WHERE course_id IS NULL")).rows[0].count, 0)
    }
    const integrityExists = (await db.query("SELECT to_regclass('public.integrity_events') AS name")).rows[0].name
    if (!integrityExists) {
      const migration = readFileSync(path.join(root, "db/migrations/20261127_001_integrity.sql"), "utf8")
      await db.query(migration.replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, ""))
    }

    const finalColumns = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'labs' AND column_name = 'allow_resubmissions'")
    if (!finalColumns.rows.length) {
      const migration = readFileSync(path.join(root, "db/migrations/20261127_002_final_submissions.sql"), "utf8")
      await db.query(migration.replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, ""))
    }

    const limitColumns = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'labs' AND column_name = 'max_submissions'")
    if (!limitColumns.rows.length) {
      const migration = readFileSync(path.join(root, "db/migrations/20261127_003_submission_limits.sql"), "utf8")
      await db.query(migration.replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, ""))
    }

    const validationColumns = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'labs' AND column_name = 'validated_at'")
    if (!validationColumns.rows.length) {
      const migration = readFileSync(path.join(root, "db/migrations/20261127_004_lab_validation.sql"), "utf8")
      await db.query(migration.replace(/^BEGIN;\s*/, "").replace(/COMMIT;\s*$/, ""))
    }

    await t.test("authentication precedes body parsing and database access", async () => {
      currentUser = undefined
      const before = queries.length
      assert.equal((await courses.POST(request("/api/courses", "bad"))).status, 401)
      assert.equal((await labs.GET(request("/api/labs"))).status, 401)
      assert.equal(queries.length, before)
    })

    currentUser = teacher
    const created = await courses.POST(request("/api/courses", { title: "Course integration fixture", description: "Temporary" }))
    assert.equal(created.status, 201)
    const courseId = (await created.json()).id
    const courseContext = context(courseId)

    function upload(id = courseId) {
      const form = new FormData()
      if (id !== undefined) form.set("course_id", id)
      form.set("title", "Temporary lab")
      form.set("allow_resubmissions", "false")
      for (const name of ["instructions", "starter", "tests", "solution"]) {
        form.set(name, new File([name === "starter" ? "def add(a, b):\n    pass\n" : "PRIVATE_FIXTURE"], `${name}.py`))
      }
      return new Request("http://localhost/api/labs", { method: "POST", body: form })
    }
    const uploaded = await labs.POST(upload())
    assert.equal(uploaded.status, 201)
    const labId = (await uploaded.json()).id
    const labContext = context(labId)

    await t.test("owner sees course counts, labs and an empty roster", async () => {
      const response = await courses.GET(request("/api/courses"))
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const course = (await response.json()).find((c) => c.id === courseId)
      assert.equal(course.lab_count, 1)
      assert.equal(course.student_count, 0)
      const fetched = await detail.GET(request("/"), courseContext)
      assert.equal((await fetched.json()).labs[0].id, labId)
      assert.deepEqual(await (await students.GET(request("/"), courseContext)).json(), [])
    })

    await t.test("unrelated teachers and unenrolled students cannot access any entry point", async () => {
      for (const user of [otherTeacher, student, otherStudent]) {
        currentUser = user
        assert.equal((await detail.GET(request("/"), courseContext)).status, 404)
        assert.equal((await labs.GET(request(`/api/labs?course_id=${courseId}`))).status, 404)
        assert.equal((await labDetail.GET(request("/"), labContext)).status, 404)
        assert.equal((await run.POST(request("/", { code: "pass" }), labContext)).status, 404)
        assert.ok(!(await (await courses.GET(request("/api/courses"))).json()).some((c) => c.id === courseId))
        assert.ok(!(await (await labs.GET(request("/api/labs"))).json()).some((l) => l.id === labId))
      }
      assert.equal(runnerCalls, 0)
      currentUser = otherTeacher
      assert.equal((await labs.POST(upload())).status, 404)
      assert.equal((await students.GET(request("/"), courseContext)).status, 404)
      assert.equal((await students.POST(request("/", { email: student.email }), courseContext)).status, 404)
    })

    await t.test("students cannot create courses, upload labs, enroll, or read rosters", async () => {
      currentUser = student
      assert.equal((await courses.POST(request("/", { title: "forbidden" }))).status, 403)
      assert.equal((await labs.POST(upload())).status, 403)
      assert.equal((await students.GET(request("/"), courseContext)).status, 403)
      assert.equal((await students.POST(request("/", { email: otherStudent.email }), courseContext)).status, 403)
    })

    await t.test("email enrollment is case-insensitive and repeatable", async () => {
      currentUser = teacher
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await students.POST(request("/", { email: ` ${student.email.toUpperCase()} ` }), courseContext)
        assert.equal(response.status, 200)
        assert.equal((await response.json()).student_id, student.id)
      }
      const roster = await (await students.GET(request("/"), courseContext)).json()
      assert.equal(roster.length, 1)
      assert.equal(roster[0].id, student.id)
      assert.equal((await students.POST(request("/", { email: teacher.email }), courseContext)).status, 422)
      assert.equal((await students.POST(request("/", { email: "missing@integration.invalid" }), courseContext)).status, 422)
    })

    await t.test("enrollment grants lab reads and runs while keeping private fields out", async () => {
      currentUser = student
      const listed = await (await courses.GET(request("/api/courses"))).json()
      const course = listed.find((c) => c.id === courseId)
      assert.equal(course.lab_count, 1)
      assert.equal("student_count" in course, false)
      assert.equal((await detail.GET(request("/"), courseContext)).status, 200)
      const listedLabs = await (await labs.GET(request(`/api/labs?course_id=${courseId}`))).json()
      assert.deepEqual(listedLabs, [{ id: labId, title: "Temporary lab", course_id: courseId }])
      const fetched = await (await labDetail.GET(request("/"), labContext)).json()
      assert.equal(fetched.course_id, courseId)
      assert.equal(fetched.starter, "def add(a, b):\n    pass\n")
      assert.equal("tests" in fetched, false)
      assert.equal("solution" in fetched, false)
      assert.equal((await run.POST(request("/", { code: "pass" }), labContext)).status, 200)
      assert.equal(runnerCalls, 1)
      assert.equal((await students.GET(request("/"), courseContext)).status, 403)
      currentUser = otherStudent
      assert.equal((await run.POST(request("/", { code: "pass" }), labContext)).status, 404)
      assert.equal(runnerCalls, 1)
    })

    await t.test("invalid bodies and course IDs are rejected", async () => {
      currentUser = teacher
      for (const body of [{ title: " " }, { title: "x", teacher_id: otherTeacher.id }, { title: "x", description: 1 }, { title: "x".repeat(201) }]) {
        assert.equal((await courses.POST(request("/", body))).status, 422)
      }
      assert.equal((await courses.POST(request("/", { title: "x" }, "text/plain"))).status, 415)
      assert.equal((await courses.POST(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).status, 400)
      assert.equal((await courses.POST(request("/", { title: "x".repeat(17000) }))).status, 413)
      assert.equal((await labs.POST(upload("invalid"))).status, 422)
      const missing = upload()
      const form = await missing.formData()
      form.delete("course_id")
      assert.equal((await labs.POST(new Request(missing.url, { method: "POST", body: form }))).status, 422)
      assert.equal((await detail.GET(request("/"), context("invalid"))).status, 400)
      assert.equal((await labs.GET(request("/api/labs?course_id=invalid"))).status, 400)
      assert.equal((await students.POST(request("/", { email: "bad" }), courseContext)).status, 422)
      assert.equal((await students.POST(request("/", { email: student.email, role: "teacher" }), courseContext)).status, 422)
    })

    await t.test("database prevents mismatched lab ownership and browser grants", async () => {
      await db.query("SAVEPOINT invalid_owner")
      await assert.rejects(db.query("UPDATE public.labs SET teacher_id = $1 WHERE id = $2", [student.id, labId]), { code: "23503" })
      await db.query("ROLLBACK TO SAVEPOINT invalid_owner")
      const grants = await db.query("SELECT grantee FROM information_schema.table_privileges WHERE table_schema = 'public' AND table_name IN ('courses', 'course_enrollments') AND grantee IN ('anon', 'authenticated', 'PUBLIC')")
      assert.equal(grants.rows.length, 0)
    })

    const sessionId = randomUUID()
    const telemetry = (type, payload = {}) => ({ event_id: randomUUID(), session_id: sessionId, type, payload, ts: "2000-01-01T00:00:00.000Z" })
    currentUser = teacher
    const integrityUpload = await labs.POST(upload())
    assert.equal(integrityUpload.status, 201)
    const integrityLab = (await integrityUpload.json()).id
    const integrityContext = context(integrityLab)

    await t.test("events and reports enforce roles and course ownership", async () => {
      currentUser = undefined
      assert.equal((await eventsRoute.POST(request("/", []), integrityContext)).status, 401)
      assert.equal((await reportRoute.GET(request("/"), integrityContext)).status, 401)
      currentUser = otherStudent
      assert.equal((await eventsRoute.POST(request("/", [telemetry("lab_opened")]), integrityContext)).status, 404)
      currentUser = student
      assert.equal((await reportRoute.GET(request("/"), integrityContext)).status, 403)
      currentUser = otherTeacher
      assert.equal((await reportRoute.GET(request("/"), integrityContext)).status, 404)
      currentUser = teacher
      assert.equal((await eventsRoute.POST(request("/", []), integrityContext)).status, 403)
      const initial = await (await reportRoute.GET(request("/"), integrityContext)).json()
      assert.equal(initial.students.find((s) => s.student_id === student.id).integrity.telemetry_status, "missing")
    })

    await t.test("event batches are atomic, bounded, allowlisted and retry-safe", async () => {
      currentUser = student
      const opened = telemetry("lab_opened")
      const paste = telemetry("paste_blocked", { chars: 300 })
      const bulk = telemetry("large_insert", { chars: 500 })
      const batch = [opened, paste, bulk, { type: "unknown_type" }]
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await eventsRoute.POST(request("/", batch), integrityContext)
        assert.equal(response.status, 204)
        assert.equal(await response.text(), "")
      }
      // Reusing an ID cannot rewrite the original payload.
      assert.equal((await eventsRoute.POST(request("/", [{ ...paste, payload: { chars: 1 } }]), integrityContext)).status, 204)
      assert.equal((await eventsRoute.POST(request("/", [telemetry("lab_opened"), { ...paste, event_id: "invalid" }]), integrityContext)).status, 400)
      assert.equal((await eventsRoute.POST(request("/", [{ ...paste, student_id: otherStudent.id }]), integrityContext)).status, 400)
      assert.equal((await eventsRoute.POST(request("/", Array(101).fill({ type: "unknown" })), integrityContext)).status, 400)
      assert.equal((await eventsRoute.POST(request("/", [], "text/plain"), integrityContext)).status, 415)
      const huge = new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(65537) })
      assert.equal((await eventsRoute.POST(huge, integrityContext)).status, 400)
      const saved = await db.query("SELECT student_id, type, payload, client_ts, received_at FROM public.integrity_events WHERE lab_id = $1 ORDER BY received_at, id", [integrityLab])
      assert.equal(saved.rows.length, 3)
      assert.deepEqual(saved.rows.map((e) => e.type), ["lab_opened", "paste_blocked", "large_insert"])
      assert.ok(saved.rows.every((e) => e.student_id === student.id))
      assert.equal(saved.rows[1].payload.chars, 300)
      assert.ok(saved.rows[0].received_at > saved.rows[0].client_ts)
    })

    await t.test("reports score server receipt times and server-recorded submissions", async () => {
      currentUser = student
      const focus = []
      for (let i = 0; i < 4; i++) focus.push(telemetry("window_blur"), telemetry("tab_hidden"), telemetry("tab_visible"), telemetry("window_focus"))
      assert.equal((await eventsRoute.POST(request("/", focus), integrityContext)).status, 204)
      assert.equal((await run.POST(request("/", { code: "pass" }), integrityContext)).status, 200)
      currentUser = teacher
      const response = await reportRoute.GET(request("/"), integrityContext)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      const report = await response.json()
      const record = report.students.find((s) => s.student_id === student.id)
      assert.equal(record.integrity.penalties.paste, 10)
      assert.equal(record.integrity.penalties.large_insert, 15)
      assert.equal(record.integrity.penalties.focus, 5)
      assert.equal(record.integrity.focus_losses, 4)
      assert.equal(record.submissions.length, 1)
      assert.ok(record.first_pass_at)
      assert.equal(record.events.length, 19)
      assert.equal(report.chat_available, false)
      assert.equal(report.students[0].student_id, student.id)
      assert.ok(!JSON.stringify(report).includes("PRIVATE_FIXTURE"))
      assert.equal("code" in record.submissions[0], false)
      assert.equal("tests" in report, false)
      // Teacher previews do not enter the student results table.
      assert.equal((await run.POST(request("/", { code: "pass" }), integrityContext)).status, 200)
      const count = await db.query("SELECT count(*)::int AS count FROM public.submissions WHERE lab_id = $1", [integrityLab])
      assert.equal(count.rows[0].count, 1)
    })

    await t.test("stored activity is append-only and has no browser grants", async () => {
      for (const table of ["integrity_events", "submissions"]) {
        for (const sql of [`UPDATE public.${table} SET student_id = student_id`, `DELETE FROM public.${table}`, `TRUNCATE public.${table}`]) {
          await db.query("SAVEPOINT activity_mutation")
          await assert.rejects(db.query(sql), { code: "55000" })
          await db.query("ROLLBACK TO SAVEPOINT activity_mutation")
        }
      }
      const grants = await db.query("SELECT grantee FROM information_schema.table_privileges WHERE table_schema = 'public' AND table_name IN ('integrity_events', 'submissions') AND grantee IN ('anon', 'authenticated', 'PUBLIC')")
      assert.equal(grants.rows.length, 0)
    })
  } finally {
    await db.query("ROLLBACK")
    await db.end()
  }
})
