# Teacher lab upload validation

`POST /api/labs` now runs the reference solution against the uploaded hidden
tests before saving a new lab. Use the existing backend API origin/proxy and
Supabase bearer token. Only teachers who own the selected course can upload.
The frontend never calls CodeRunner directly or supplies a validation verdict.

## Request

Send `multipart/form-data` with the existing fields:

| Field | Value / maximum |
| --- | --- |
| `course_id` | UUID of an owned course |
| `title` | Nonempty title |
| `max_submissions` | Positive integer text, e.g. `"3"`, or `"unlimited"` |
| `instructions` | One nonempty UTF-8 file, at most 1 MiB |
| `starter` | One nonempty UTF-8 Python file, at most 64 KiB |
| `tests` | One nonempty UTF-8 Python unittest file, at most 64 KiB |
| `solution` | One nonempty UTF-8 reference solution file, at most 64 KiB |

Null characters are rejected. Limits count bytes, not JavaScript characters.
Legacy `allow_resubmissions` remains supported as described in the
[submission contract](frontend-final-submissions.md). Do not manually set the
multipart Content-Type header; the browser supplies the boundary.

Tests must use `unittest.TestCase` methods named `test_*` and import submitted
symbols from `solution`. Top-level `def test_*` functions are not discovered.
Use equality assertions with actual value first, expected value second. Test
docstrings or `subTest(msg=...)` provide helpful teacher diagnostic labels.

## Validation and persistence

After authentication, ownership and file checks, the backend sends only
`{solution, tests}` to the runner's `POST /validate`. It does not send starter
code, browser credentials, or a timeout override. The request has a 30-second
deadline, a 512-KiB serialized JSON limit, and a 1-MiB response limit.

Acceptance requires a consistent response with `valid=true`, `status="ok"`,
at least one test, all tests run and passed, and zero failed tests. Missing
labels and slow-test warnings do not block an otherwise passing lab. Runner
internal errors are service failures, not invalid-lab verdicts.

The exact decoded solution and tests that passed validation are saved with the
lab. Ownership is checked again during insertion. HTTP 201 is returned only
after persistence succeeds. Invalid labs create no row. Reference validation
does not create a student practice attempt or consume a final-submission slot.

## Response types

```ts
type ValidationSummary = {
  valid: true
  status: "ok"
  total_tests: number
  passed_tests: number
  warnings: string[]
}

type UploadSuccess = {
  id: string
  validated_at: string // server ISO timestamp
  validation: ValidationSummary
}

type TeacherDiagnostic = {
  index: number
  name: string
  display_name: string
  status: "passed" | "failed" | "timeout" | "not_run"
  passed: boolean
  duration_ms: number
  inputs?: string
  expected?: string
  actual?: string
  error_type?: string
  error_message?: string
  full_traceback?: string
  stdout?: string
}

type LabValidation = {
  valid: boolean
  summary: string
  status: "ok" | "syntax_error" | "runtime_error" | "timeout" | "oom"
  duration_ms: number
  total_tests: number
  ran_tests: number
  passed_tests: number
  failed_tests: number
  tests: TeacherDiagnostic[]
  warnings: string[]
  stdout?: string
  syntax_error?: {
    source: "solution" | "tests"
    error_type: string
    error_message?: string
    line: number
    code_line?: string
  }
}

type InvalidLab = {
  code: "LAB_VALIDATION_FAILED"
  error: string
  validation: LabValidation
}

type ValidationServiceError = {
  code: "LAB_VALIDATION_SERVICE_ERROR"
  error: string
}
```

Success includes only a compact summary. HTTP 422 invalid-lab responses include
allowlisted teacher diagnostics, such as expected/actual values and test
tracebacks. Unknown upstream fields and raw infrastructure error bodies are
discarded. Diagnostics and warnings are untrusted text: render them as plain
text or escaped `<pre>` content, never HTML.

## Status handling

| HTTP | Body / meaning | Frontend behavior |
| --- | --- | --- |
| `201` | `UploadSuccess` | Show saved lab and non-blocking warnings |
| `400` | `{error}`; malformed multipart | Correct request construction |
| `401`, `403` | `{error}`; authentication/profile/role restriction | Refresh authentication or show access restriction |
| `404` | `{error}`; missing/inaccessible course | Refresh course selection |
| `413` | `{errors}` for oversized files, or `ValidationServiceError` for serialized/runner size limits | Reduce file sizes |
| `422` | `{errors}` for upload fields, encoding, or empty files | Show field errors |
| `422` | `InvalidLab` | Show test/syntax diagnostics; keep selected files |
| `429` | `ValidationServiceError`, `Retry-After: 2` | Runner busy; allow retry with backoff |
| `502` | `ValidationServiceError` | Runner failure, malformed result, or network error; allow retry |
| `503` | `ValidationServiceError` | Runner unavailable or unconfigured |
| `504` | `ValidationServiceError` | Runner request exceeded its deadline |
| `500` | `{error}` | Backend/database/authentication failure; upload not confirmed |

Use `code` to distinguish an invalid lab from a service failure. A failed test
does not produce HTTP 201. Student Run/Submit contracts remain unchanged.

## Upload screen behavior

1. Keep the selected files and form values in state.
2. On Upload, capture one FormData snapshot and disable repeated clicks while
   the request is pending. Show **Validating reference solution and saving lab…**.
3. On `201`, show the saved lab and warnings. Use the returned ID for navigation.
4. On `422 LAB_VALIDATION_FAILED`, show the summary, passing/total counts, and
   failed test details. For syntax errors identify the file and line. Keep the
   form open so the teacher can replace the relevant file and upload again.
5. On service errors, preserve the form and show a retry action. Do not describe
   an infrastructure failure as incorrect teacher code.
6. On an uncertain network response or `500`, check the teacher's lab list before
   retrying. Upload is not idempotent: losing a response after a successful save
   can otherwise cause duplicate labs. Disabling duplicate clicks does not solve
   that network case. No automatic upload retry is provided.

One request handles both validation and saving; there is no separate preview
endpoint or frontend-provided validation token.

## Audit data, existing labs, and confidentiality

Apply `db/migrations/20261127_004_lab_validation.sql` after the existing migrations.
It adds nullable `validated_at` and `validation_summary` columns. Existing labs
stay unchanged with both fields NULL; they are not retrospectively validated or
blocked. The normal policy PATCH endpoint does not change uploaded source or
validation records.

For the course owner, `GET /api/labs/{id}` additionally returns `validated_at`
and `validation` (the compact summary). Both are null for a legacy lab. Student
lab detail responses omit these fields. Validation diagnostics and summaries
are absent from student execution results and accepted-submission payloads.

Passing validation proves that this reference solution passes these supplied
tests. It does not prove coverage of every instruction or edge case.

## Verification

`npm test` covers real upload/runner-adapter code with mocked auth, database,
and HTTP boundaries, including failure responses and persistence errors.
The PostgreSQL suites also exercise audit persistence, legacy migration,
teacher-only retrieval, and a real database insert failure after validation:

```bash
node --env-file=.env.local tests/integration/final-submissions.test.mjs
node --env-file=.env.local tests/integration/courses.test.mjs
```

Run synthetic examples through the production adapter against a running
CodeRunner (with its Docker sandbox available). This writes no database rows:

```bash
node --env-file=.env.local tests/integration/runner-validation.test.mjs
```

The separate frontend should verify loading state, retained file selections,
escaped diagnostics, warning-only success, and service-error recovery in browser
tests. No frontend application source is present in this backend workspace.
