import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { test } from "node:test"
import pg from "pg"
import ts from "typescript"

const root = fileURLToPath(new URL("../../", import.meta.url))
const require = createRequire(import.meta.url)

test("final submission routes and concurrency against PostgreSQL", { skip: !process.env.DATABASE_URL }, async (t) => {
  const schema = `final_test_${randomUUID().replaceAll("-", "")}`
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 8, connectionTimeoutMillis: 10000 })
  const sqlForTest = (sql) => sql.replaceAll("public.", `${schema}.`)
  const query = (sql, values) => db.query(sqlForTest(sql), values)
  const teacher = { id: randomUUID(), role: "teacher" }
  const otherTeacher = { id: randomUUID(), role: "teacher" }
  const student = { id: randomUUID(), role: "student" }
  const outsider = { id: randomUUID(), role: "student" }
  const courseId = randomUUID()
  const otherCourseId = randomUUID()
  const fixtureCode = "def add(a, b):\n    return a + b\n"
  const hidden = "PRIVATE_TEST_SENTINEL"
  let runnerCalls = 0
  let runnerBehavior
  let failOutcome = false
  let loseCommit = false
  let crashConnection = false
  let activeClient
  const executed = []
  const passed = () => ({ status: "ok", score: 100, passed: 1, failed: 0, ran: 1, total: 1, tests: [{ name: hidden, passed: true, status: "passed", stdout: hidden }] })

  function handlers(user) {
    const cache = new Map()
    function load(relative) {
      const filename = path.resolve(root, relative)
      if (filename === path.join(root, "lib/auth.ts")) return { requireUser: async (_req, role) => {
        if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) }
        if (role && role !== user.role) return { error: Response.json({ error: "Forbidden" }, { status: 403 }) }
        return { user }
      } }
      if (filename === path.join(root, "lib/db.ts")) return { pool: {
        query,
        connect: async () => {
          const client = await db.connect()
          activeClient = client
          let destroyed = false
          return {
            query: async (sql, values) => {
              if (failOutcome && sql.includes("INSERT INTO public.submission_outcomes")) {
                failOutcome = false
                throw new Error("Simulated save failure")
              }
              if (crashConnection && sql.includes("INSERT INTO public.submissions")) {
                crashConnection = false
                destroyed = true
                client.release(true)
                throw new Error("Simulated worker connection loss")
              }
              if (destroyed) throw new Error("Connection closed")
              const result = await client.query(sqlForTest(sql), values)
              if (loseCommit && sql === "COMMIT") {
                loseCommit = false
                throw new Error("Simulated lost commit acknowledgement")
              }
              return result
            },
            release: (destroy) => { if (!destroyed) client.release(destroy) },
          }
        },
      } }
      if (cache.has(filename)) return cache.get(filename)
      const exports = {}
      cache.set(filename, exports)
      const source = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
      vm.runInNewContext(source, {
        exports, Request, Response, URL, File, Buffer, TextDecoder, AbortSignal, console: { error() {} },
        process: { env: { RUNNER_URL: "http://runner.test" } },
        fetch: async (_url, init) => {
          runnerCalls++
          executed.push(JSON.parse(init.body))
          return Response.json(runnerBehavior ? await runnerBehavior() : passed())
        },
        require: (name) => name.startsWith("node:") ? require(name) : load(path.resolve(path.dirname(filename), `${name}.ts`)),
      }, { filename })
      return exports
    }
    return {
      submit: load("app/api/labs/[id]/submit/route.ts"),
      status: load("app/api/labs/[id]/submission/route.ts"),
      inspect: load("app/api/submissions/[submissionId]/route.ts"),
      overview: load("app/api/courses/[id]/students/[studentId]/report/route.ts"),
      report: load("app/api/labs/[id]/report/route.ts"),
      run: load("app/api/labs/[id]/run/route.ts"),
      upload: load("app/api/labs/route.ts"),
      detail: load("app/api/labs/[id]/route.ts"),
    }
  }
  const context = (id) => ({ params: Promise.resolve({ id }) })
  const get = () => new Request("http://localhost/api/test")
  function submit(h, labId, key = randomUUID(), code = fixtureCode) {
    return h.submit.POST(new Request("http://localhost/api/test", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ code }) }), context(labId))
  }
  async function makeLab(allow = false, course = courseId, owner = teacher.id) {
    const result = await query("INSERT INTO public.labs (teacher_id, course_id, title, instructions, starter, tests, solution, allow_resubmissions, max_submissions) VALUES ($1,$2,'Fixture','Instructions','pass',$3,'pass',$4,$5) RETURNING id", [owner, course, hidden, allow, allow ? null : 1])
    return result.rows[0].id
  }
  try {
    await db.query(`CREATE SCHEMA ${schema}`)
    // Clone the existing prerequisite tables into an isolated schema. Activity
    // tables are created from the actual migrations, including their triggers.
    for (const table of ["profiles", "courses", "course_enrollments", "labs"]) {
      await db.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`)
    }
    await db.query(`ALTER TABLE ${schema}.labs DROP COLUMN IF EXISTS max_submissions`)
    await db.query(`ALTER TABLE ${schema}.labs DROP COLUMN IF EXISTS allow_resubmissions`)
    for (const file of ["20261127_001_integrity.sql"]) {
      await query(readFileSync(path.join(root, "db/migrations", file), "utf8"))
    }
    for (const user of [teacher, otherTeacher, student, outsider]) {
      await query("INSERT INTO public.profiles (id,email,role) VALUES ($1,$2,$3)", [user.id, `${user.id}@example.test`, user.role])
    }
    await query("INSERT INTO public.courses (id,teacher_id,title) VALUES ($1,$2,'Course A'),($3,$4,'Course B')", [courseId, teacher.id, otherCourseId, otherTeacher.id])
    await query("INSERT INTO public.course_enrollments (course_id,student_id) VALUES ($1,$2),($3,$2)", [courseId, student.id, otherCourseId])
    const legacyLab = (await query("INSERT INTO public.labs (teacher_id,course_id,title,instructions,starter,tests,solution) VALUES ($1,$2,'Legacy','Read','pass',$3,'pass') RETURNING id", [teacher.id, courseId, hidden])).rows[0].id
    await query("INSERT INTO public.submissions (lab_id,student_id,code,status,results,score,passed,total) VALUES ($1,$2,'legacy source','ok','[]',0,0,0)", [legacyLab, student.id])
    await query(readFileSync(path.join(root, "db/migrations/20261127_002_final_submissions.sql"), "utf8"))
    const legacyUnlimited = (await query("INSERT INTO public.labs (teacher_id,course_id,title,instructions,starter,tests,solution,allow_resubmissions) VALUES ($1,$2,'Legacy unlimited','Read','pass',$3,'pass',true) RETURNING id", [teacher.id, courseId, hidden])).rows[0].id
    await query(readFileSync(path.join(root, "db/migrations/20261127_003_submission_limits.sql"), "utf8"))
    await t.test("migration preserves existing runs as practice and defaults old labs to locked policy", async () => {
      const legacy = await query("SELECT l.allow_resubmissions,s.kind,s.code FROM public.labs l JOIN public.submissions s ON s.lab_id=l.id WHERE l.id=$1", [legacyLab])
      assert.equal(legacy.rows[0].allow_resubmissions, false)
      assert.equal(legacy.rows[0].kind, "practice")
      assert.equal(legacy.rows[0].code, "legacy source")
      const limits = await query("SELECT id,max_submissions FROM public.labs WHERE id IN ($1,$2)", [legacyLab, legacyUnlimited])
      assert.equal(limits.rows.find((row) => row.id === legacyLab).max_submissions, 1)
      assert.equal(limits.rows.find((row) => row.id === legacyUnlimited).max_submissions, null)
    })
    const learner = handlers(student)
    const owner = handlers(teacher)
    const unrelated = handlers(otherTeacher)
    const lockedLab = await makeLab()
    const repeatLab = await makeLab(true)
    const privateLab = await makeLab(true, otherCourseId, otherTeacher.id)
    let acceptedId

    await t.test("passing practice never submits, and Submit verifies the current code again", async () => {
      const lab = await makeLab(true)
      const initial = await (await learner.status.GET(get(), context(lab))).json()
      assert.equal(initial.accepted_submission, null)
      assert.equal(initial.can_submit, true)
      const practice = await learner.run.POST(new Request("http://localhost", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: fixtureCode }),
      }), context(lab))
      assert.equal(practice.status, 200)
      assert.equal((await (await learner.status.GET(get(), context(lab))).json()).accepted_submission, null)
      const before = runnerCalls
      runnerBehavior = () => ({ ...passed(), passed: 0, failed: 1, score: 0, tests: [{ passed: false, status: "failed", error_message: hidden }] })
      try {
        const response = await submit(learner, lab, randomUUID(), "def add(a, b):\n    return 0\n")
        assert.equal(response.status, 200)
        const body = await response.json()
        assert.equal(body.accepted, false)
        assert.equal(body.submitted_at, null)
        assert.equal(runnerCalls, before + 1)
        assert.equal(executed.at(-1).code, "def add(a, b):\n    return 0\n")
        assert.ok(!JSON.stringify(body).includes(hidden))
        const rows = await query("SELECT kind FROM public.submissions WHERE lab_id=$1", [lab])
        assert.deepEqual(rows.rows, [{ kind: "practice" }])
      } finally { runnerBehavior = undefined }
    })

    await t.test("upload requires explicit true/false and lab details expose the setting", async () => {
      function form(value) {
        const data = new FormData()
        data.set("course_id", courseId)
        data.set("title", "Upload fixture")
        if (value !== undefined) data.set("allow_resubmissions", value)
        for (const field of ["instructions", "starter", "tests", "solution"]) data.set(field, new File(["pass"], `${field}.py`))
        return data
      }
      for (const value of [undefined, "on", "1", "TRUE"]) {
        const response = await owner.upload.POST(new Request("http://localhost", { method: "POST", body: form(value) }))
        assert.equal(response.status, 422)
      }
      for (const value of ["false", "true"]) {
        const response = await owner.upload.POST(new Request("http://localhost", { method: "POST", body: form(value) }))
        assert.equal(response.status, 201)
        const lab = await response.json()
        const detail = await learner.detail.GET(get(), context(lab.id))
        assert.equal((await detail.json()).allow_resubmissions, value === "true")
      }
    })

    await t.test("passing Submit persists exact verified source and replays after lock", async () => {
      const key = randomUUID()
      const response = await submit(learner, lockedLab, key)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.accepted, true)
      acceptedId = body.submission_id
      assert.ok(body.submitted_at)
      assert.equal(executed.at(-1).code, fixtureCode)
      assert.equal(executed.at(-1).tests, hidden)
      assert.ok(!JSON.stringify(body).includes(hidden))
      const before = runnerCalls
      assert.deepEqual(await (await submit(learner, lockedLab, key)).json(), body)
      assert.equal(runnerCalls, before)
      const mismatch = await submit(learner, lockedLab, key, "pass")
      assert.equal(mismatch.status, 409)
      assert.equal((await mismatch.json()).code, "IDEMPOTENCY_KEY_REUSED")
      const locked = await submit(learner, lockedLab)
      assert.equal(locked.status, 409)
      assert.equal((await locked.json()).code, "FINAL_SUBMISSION_LOCKED")
      const status = await (await learner.status.GET(get(), context(lockedLab))).json()
      assert.equal(status.allow_resubmissions, false)
      assert.equal(status.can_submit, false)
      assert.equal(status.accepted_submission.submission_id, acceptedId)
      assert.equal(status.accepted_submission.code_sha256, createHash("sha256").update(fixtureCode).digest("hex"))
      const inspection = await owner.inspect.GET(get(), { params: Promise.resolve({ submissionId: acceptedId }) })
      const saved = await inspection.json()
      assert.equal(saved.code, fixtureCode)
      assert.deepEqual(saved.execution, body.execution)
    })

    await t.test("failed execution replays without locking and a new key can pass", async () => {
      const lab = await makeLab()
      const key = randomUUID()
      runnerBehavior = () => ({ ...passed(), passed: 0, failed: 1, score: 0, tests: [{ name: hidden, passed: false, status: "failed", error_message: hidden }] })
      const rejected = await (await submit(learner, lab, key)).json()
      assert.equal(rejected.accepted, false)
      assert.equal(rejected.submission_id, null)
      const before = runnerCalls
      runnerBehavior = undefined
      assert.deepEqual(await (await submit(learner, lab, key)).json(), rejected)
      assert.equal(runnerCalls, before)
      assert.equal((await (await learner.status.GET(get(), context(lab))).json()).can_submit, true)
      assert.equal((await (await submit(learner, lab)).json()).accepted, true)
    })

    await t.test("syntax/runtime/timeouts/OOM and zero tests never accept", async () => {
      for (const status of ["syntax_error", "runtime_error", "timeout", "oom", "ok"]) {
        runnerBehavior = () => ({ status, score: 0, ran: 0, passed: 0, failed: 0, total: 0, tests: [] })
        const response = await submit(learner, repeatLab)
        assert.equal(response.status, status === "ok" ? 422 : 200)
        if (status !== "ok") assert.equal((await response.json()).accepted, false)
      }
      runnerBehavior = undefined
    })

    await t.test("allowed resubmissions preserve versions and replay the original version", async () => {
      const key = randomUUID()
      const first = await (await submit(learner, repeatLab, key)).json()
      const second = await (await submit(learner, repeatLab, randomUUID(), `${fixtureCode}\n`)).json()
      assert.notEqual(first.submission_id, second.submission_id)
      assert.deepEqual(await (await submit(learner, repeatLab, key)).json(), first)
      const status = await (await learner.status.GET(get(), context(repeatLab))).json()
      assert.equal(status.allow_resubmissions, true)
      assert.equal(status.can_submit, true)
      assert.equal(status.accepted_submission.version, 2)
      assert.equal(status.accepted_submission.submission_id, second.submission_id)
      runnerBehavior = () => ({ ...passed(), passed: 0, failed: 1, score: 0, tests: [{ passed: false, status: "failed" }] })
      try {
        assert.equal((await (await submit(learner, repeatLab)).json()).accepted, false)
        const afterFailure = await (await learner.status.GET(get(), context(repeatLab))).json()
        assert.deepEqual(afterFailure.accepted_submission, status.accepted_submission)
      } finally { runnerBehavior = undefined }
    })

    await t.test("concurrent same/different keys serialize and preserve the lock rule", async () => {
      const lab = await makeLab()
      const key = randomUUID()
      let signalStarted
      const started = new Promise((resolve) => { signalStarted = resolve })
      let finishExecution
      runnerBehavior = async () => { signalStarted(); await new Promise((resolve) => { finishExecution = resolve }); return passed() }
      const first = submit(learner, lab, key)
      await started
      try {
        for (const duplicateKey of [key, randomUUID()]) {
          const duplicate = await submit(learner, lab, duplicateKey)
          assert.equal(duplicate.status, 409)
          assert.equal((await duplicate.json()).code, "SUBMISSION_PROCESSING")
          assert.equal(duplicate.headers.get("retry-after"), "2")
        }
      } finally { finishExecution() }
      assert.equal((await (await first).json()).accepted, true)
      runnerBehavior = undefined
      assert.equal((await (await submit(learner, lab)).json()).code, "FINAL_SUBMISSION_LOCKED")
      const count = await query("SELECT count(*)::int AS count FROM public.submissions WHERE lab_id=$1 AND kind='final'", [lab])
      assert.equal(count.rows[0].count, 1)
    })

    await t.test("save failure, lost commit acknowledgement and connection loss recover", async () => {
      for (const failure of ["save", "commit", "crash"]) {
        const lab = await makeLab()
        const key = randomUUID()
        failOutcome = failure === "save"
        loseCommit = failure === "commit"
        crashConnection = failure === "crash"
        const failed = await submit(learner, lab, key)
        assert.equal(failed.status, 500)
        const before = runnerCalls
        const recovered = await submit(learner, lab, key)
        assert.equal(recovered.status, 200)
        assert.equal((await recovered.json()).accepted, true)
        assert.equal(runnerCalls, before + (failure === "commit" ? 0 : 1))
        const count = await query("SELECT count(*)::int AS count FROM public.submissions WHERE lab_id=$1 AND kind='final'", [lab])
        assert.equal(count.rows[0].count, 1)
      }
      assert.ok(activeClient)
    })

    await t.test("authorization and course-scoped reports exclude unrelated activity", async () => {
      assert.equal((await submit(handlers(undefined), repeatLab)).status, 401)
      assert.equal((await submit(owner, repeatLab)).status, 403)
      assert.equal((await submit(handlers(outsider), repeatLab)).status, 404)
      assert.equal((await unrelated.inspect.GET(get(), { params: Promise.resolve({ submissionId: acceptedId }) })).status, 404)
      assert.equal((await learner.inspect.GET(get(), { params: Promise.resolve({ submissionId: acceptedId }) })).status, 403)
      await submit(learner, privateLab)
      const practiceRequest = () => new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "pass" }) })
      for (let i = 0; i < 2; i++) assert.equal((await learner.run.POST(practiceRequest(), context(lockedLab))).status, 200)
      assert.equal((await owner.run.POST(practiceRequest(), context(lockedLab))).status, 200)
      const params = { params: Promise.resolve({ id: courseId, studentId: student.id }) }
      const overview = await owner.overview.GET(get(), params)
      const report = await overview.json()
      assert.equal(overview.status, 200)
      assert.ok(!report.labs.some((l) => l.lab_id === privateLab))
      const lab = report.labs.find((l) => l.lab_id === lockedLab)
      assert.equal(lab.practice_attempt_count, 2)
      assert.equal(lab.accepted_submission.submission_id, acceptedId)
      assert.equal(lab.integrity_scope, "current_lab")
      assert.equal(lab.integrity.telemetry_status, "missing")
      assert.equal((await unrelated.overview.GET(get(), params)).status, 404)
      const timeline = await (await owner.report.GET(get(), context(lockedLab))).json()
      const activity = timeline.students.find((s) => s.student_id === student.id)
      assert.equal(activity.submissions.filter((s) => s.kind === "final").length, 1)
      assert.equal(activity.submissions.filter((s) => s.kind === "practice").length, 2)
    })

    await t.test("database constraints reject a failed final and enforce locked labs", async () => {
      const key = randomUUID()
      const request = await query("INSERT INTO public.submission_requests (lab_id,student_id,idempotency_key,code) VALUES ($1,$2,$3,'pass') RETURNING id", [repeatLab, student.id, key])
      await assert.rejects(query("INSERT INTO public.submissions (lab_id,student_id,code,status,results,score,passed,total,kind,request_id,code_sha256) VALUES ($1,$2,'pass','ok','[]',0,0,0,'final',$3,$4)", [repeatLab, student.id, request.rows[0].id, "0".repeat(64)]), { code: "23514" })
      const lockedRequest = await query("INSERT INTO public.submission_requests (lab_id,student_id,idempotency_key,code) VALUES ($1,$2,$3,'pass') RETURNING id", [lockedLab, student.id, randomUUID()])
      await assert.rejects(query("INSERT INTO public.submissions (lab_id,student_id,code,status,results,score,passed,total,kind,request_id,code_sha256) VALUES ($1,$2,'pass','ok','[{\"name\":\"Test 1\",\"passed\":true,\"error\":null}]',100,1,1,'final',$3,$4)", [lockedLab, student.id, lockedRequest.rows[0].id, "0".repeat(64)]), { code: "23514", constraint: "final_submission_locked" })
    })

    await t.test("numeric upload limits and owner-only changes are validated", async () => {
      const form = new FormData()
      form.set("course_id", courseId)
      form.set("title", "Limited upload")
      form.set("max_submissions", "3")
      for (const field of ["instructions", "starter", "tests", "solution"]) form.set(field, new File(["pass"], `${field}.py`))
      const uploaded = await owner.upload.POST(new Request("http://localhost", { method: "POST", body: form }))
      assert.equal(uploaded.status, 201)
      const lab = (await uploaded.json()).id
      assert.equal((await (await learner.detail.GET(get(), context(lab))).json()).max_submissions, 3)
      const patch = (body) => new Request("http://localhost", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      assert.equal((await learner.detail.PATCH(patch({ max_submissions: 2 }), context(lab))).status, 403)
      assert.equal((await unrelated.detail.PATCH(patch({ max_submissions: 2 }), context(lab))).status, 404)
      for (const value of [0, -1, 1.5, "2", true, 2147483648]) {
        assert.equal((await owner.detail.PATCH(patch({ max_submissions: value }), context(lab))).status, 422)
      }
      assert.equal((await owner.detail.PATCH(patch({ max_submissions: 2, student_id: student.id }), context(lab))).status, 422)
      for (const value of [2, null, 1]) {
        const response = await owner.detail.PATCH(patch({ max_submissions: value }), context(lab))
        assert.equal(response.status, 200)
        assert.equal((await response.json()).max_submissions, value)
      }
    })

    await t.test("finite limits count accepted finals only and permit recovery after increasing the limit", async () => {
      const lab = await makeLab(true)
      const patch = (limit) => owner.detail.PATCH(new Request("http://localhost", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ max_submissions: limit }),
      }), context(lab))
      assert.equal((await patch(2)).status, 200)
      const firstKey = randomUUID()
      const first = await (await submit(learner, lab, firstKey)).json()
      runnerBehavior = () => ({ ...passed(), passed: 0, failed: 1, score: 0, tests: [{ passed: false, status: "failed" }] })
      try { assert.equal((await (await submit(learner, lab)).json()).accepted, false) }
      finally { runnerBehavior = undefined }
      const afterFailure = await (await learner.status.GET(get(), context(lab))).json()
      assert.equal(afterFailure.accepted_submission_count, 1)
      assert.equal(afterFailure.remaining_submissions, 1)
      // Two requests compete for the last remaining slot.
      let startedResolve, finishResolve
      const started = new Promise((resolve) => { startedResolve = resolve })
      runnerBehavior = async () => { startedResolve(); await new Promise((resolve) => { finishResolve = resolve }); return passed() }
      const last = submit(learner, lab)
      await started
      const competingKey = randomUUID()
      try {
        assert.equal((await (await submit(learner, lab, competingKey)).json()).code, "SUBMISSION_PROCESSING")
      } finally { finishResolve() }
      assert.equal((await (await last).json()).accepted, true)
      runnerBehavior = undefined
      const before = runnerCalls
      const blocked = await submit(learner, lab, competingKey)
      assert.equal(blocked.status, 409)
      assert.equal((await blocked.json()).code, "SUBMISSION_LIMIT_REACHED")
      assert.equal(runnerCalls, before)
      assert.deepEqual(await (await submit(learner, lab, firstKey)).json(), first)
      const full = await (await learner.status.GET(get(), context(lab))).json()
      assert.equal(full.accepted_submission_count, 2)
      assert.equal(full.remaining_submissions, 0)
      assert.equal(full.can_submit, false)
      const request = await query("INSERT INTO public.submission_requests (lab_id,student_id,idempotency_key,code) VALUES ($1,$2,$3,'pass') RETURNING id", [lab, student.id, randomUUID()])
      await assert.rejects(query("INSERT INTO public.submissions (lab_id,student_id,code,status,results,score,passed,total,kind,request_id,code_sha256) VALUES ($1,$2,'pass','ok','[{\"name\":\"Test 1\",\"passed\":true,\"error\":null}]',100,1,1,'final',$3,$4)", [lab, student.id, request.rows[0].id, "0".repeat(64)]), { code: "23514", constraint: "final_submission_limit_reached" })
      assert.equal((await patch(3)).status, 200)
      // Terminal outcomes remain immutable, even after a policy change.
      assert.equal((await (await submit(learner, lab, competingKey)).json()).code, "SUBMISSION_LIMIT_REACHED")
      assert.equal((await (await submit(learner, lab)).json()).accepted, true)
      assert.equal((await (await learner.status.GET(get(), context(lab))).json()).accepted_submission_count, 3)
      assert.equal((await patch(1)).status, 200)
      const lowered = await (await learner.status.GET(get(), context(lab))).json()
      assert.equal(lowered.accepted_submission_count, 3)
      assert.equal(lowered.remaining_submissions, 0)
      const report = await (await owner.report.GET(get(), context(lab))).json()
      assert.equal(report.max_submissions, 1)
      assert.equal(report.students.find((s) => s.student_id === student.id).accepted_submission_count, 3)
    })

    await t.test("revoked enrollment prevents status and replay while the owner retains historical access", async () => {
      const lab = await makeLab(true)
      const key = randomUUID()
      const accepted = await (await submit(learner, lab, key)).json()
      await query("DELETE FROM public.course_enrollments WHERE course_id=$1 AND student_id=$2", [courseId, student.id])
      const before = runnerCalls
      assert.equal((await submit(learner, lab, key)).status, 404)
      assert.equal((await learner.status.GET(get(), context(lab))).status, 404)
      assert.equal(runnerCalls, before)
      assert.equal((await owner.inspect.GET(get(), { params: Promise.resolve({ submissionId: accepted.submission_id }) })).status, 200)
      const report = await owner.overview.GET(get(), { params: Promise.resolve({ id: courseId, studentId: student.id }) })
      assert.equal(report.status, 200)
      assert.equal((await report.json()).labs.find((item) => item.lab_id === lab).accepted_submission.submission_id, accepted.submission_id)
    })
  } finally {
    runnerBehavior = undefined
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await db.end()
  }
})
