This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Courses and enrollment

Apply `db/migrations/20261126_001_courses.sql` once before deploying these routes.
The migration runs in a transaction, creates `courses` and `course_enrollments`,
and adds the required `labs.course_id` foreign key. Each existing lab is placed
in an **Imported labs** course belonging to its teacher. The migration creates
one such course per teacher who already has labs. Teachers then enroll students
explicitly. A compound foreign key enforces matching lab and course ownership.
Reapplying the file fails and rolls back. Keep applied migration files immutable.

All routes require a Supabase bearer token. Database profile roles determine
access. Teachers see and manage their own courses. Students see enrolled courses
and their labs. An inaccessible course or lab returns `404`. Teacher-only routes
return `403` for students. Successful reads use `Cache-Control: private, no-store`.

| Method and route | Request | Response |
| --- | --- | --- |
| `POST /api/courses` | JSON `{"title":"Python basics","description":"Week one"}` | `201 {"id":"<uuid>"}` |
| `GET /api/courses` | — | Array of `{id,title,description,created_at,lab_count}`. Teachers also receive `student_count`. |
| `GET /api/courses/{id}` | — | `{id,teacher_id,title,description,created_at,labs:[{id,title}]}` |
| `POST /api/courses/{id}/students` | JSON `{"email":"student@example.com"}` | `200 {course_id,student_id,enrolled_at}` |
| `GET /api/courses/{id}/students` | — | Owner-only array of `{id,email,full_name,enrolled_at}` |
| `POST /api/labs` | Existing multipart fields plus `course_id` and `max_submissions`; validates reference solution before saving | `201 {id, validated_at, validation}` |
| `GET /api/labs?course_id={id}` | Optional course filter | Accessible labs as `[{id,title,course_id}]` |

Course titles are trimmed and limited to 1–200 characters. Description is optional,
defaults to an empty string, and is limited to 5000 characters. Course creation
and enrollment accept JSON bodies up to 16 KiB. Extra JSON fields are rejected.
These endpoints return `400` for malformed JSON/IDs, `413` for oversized JSON,
`415` for an incorrect content type, and `422` for invalid fields.

Enrollment requires an existing student profile. Email matching ignores case and
surrounding whitespace. Repeated enrollment returns the existing membership,
and a database unique key prevents duplicates during simultaneous requests.
An unknown email or teacher account returns `422`. Ambiguous duplicate profile
emails return `409` for administrator correction. Enrollment grants access to
all existing and future labs in the course.

The frontend can select its dashboard using `/api/me` and populate course cards
using `/api/courses`. Teachers can open a course's roster and upload labs with
that course's ID. Students can open the course and its labs. Teachers can read
student execution results and integrity activity through the lab report below.

Create a course using a teacher token, then use the returned ID as `COURSE_ID`.

```bash
curl -i http://localhost:3000/api/courses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"title":"Python basics","description":"Introductory Python labs"}'

curl -i "http://localhost:3000/api/courses/$COURSE_ID/students" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"email":"student@example.com"}'

curl "http://localhost:3000/api/courses/$COURSE_ID/students" \
  -H "Authorization: Bearer $TOKEN"

curl -i http://localhost:3000/api/labs \
  -H "Authorization: Bearer $TOKEN" \
  -F "course_id=$COURSE_ID" -F 'title=Addition' \
  -F 'max_submissions=1' \
  -F 'instructions=@demo-lab/instructions.md' \
  -F 'starter=@demo-lab/starter.py' \
  -F 'tests=@demo-lab/tests.py' \
  -F 'solution=@demo-lab/solution.py'

curl "http://localhost:3000/api/courses/$COURSE_ID" \
  -H "Authorization: Bearer $TOKEN"
```

The bundled `demo-lab/tests.py` uses compatible `unittest.TestCase` methods.
New uploads require exactly one `max_submissions` text field containing a
positive integer or `unlimited`, and exactly one valid `course_id` field. Missing
or invalid values return `422`. Legacy `allow_resubmissions=true/false` is also
accepted instead of the numeric field. The teacher must own the selected course.

The course feature uses the existing `DATABASE_URL` and `SUPABASE_URL`.
Run its PostgreSQL integration check explicitly against the development database
with one teacher and at least two student profiles available.

```bash
node --env-file=.env.local --test tests/integration/courses.test.mjs
```

The test executes the real route handlers and SQL with mocked authentication and
runner boundaries. All writes are rolled back. It also verifies the migration
when the course tables are absent. `npm test` runs the isolated runner suite.

## Lab fetch API

Both GET routes require a Supabase access token in `Authorization: Bearer <token>`.
Students can read labs in enrolled courses, and teachers can read labs in their
own courses. Responses contain student-visible fields, and successful responses
use `Cache-Control: private, no-store`.

List labs, newest first (an empty database returns `[]`):

```bash
curl http://localhost:3000/api/labs \
  -H "Authorization: Bearer $TOKEN"
```

HTTP 200:

```json
[{"id":"11111111-1111-4111-8111-111111111111","title":"Addition","course_id":"22222222-2222-4222-8222-222222222222"}]
```

Fetch a lab using an ID returned by the list or upload route:

```bash
curl "http://localhost:3000/api/labs/$LAB_ID" \
  -H "Authorization: Bearer $TOKEN"
```

HTTP 200 (example contents):

```json
{"id":"11111111-1111-4111-8111-111111111111","title":"Addition","instructions":"# Addition\nImplement add(a, b).\n","starter":"def add(a, b):\n    pass\n","course_id":"22222222-2222-4222-8222-222222222222"}
```

Student executions are stored in `submissions`. The lab fetch contract still
omits `solved` and `last_code`. The frontend can initialize the editor with
`starter`. Lab detail also includes `max_submissions`, `allow_resubmissions`, and the backend's `integrity_policy`, documented
in `docs/frontend-integrity.md`.
Lab details do not return test source or reference solution source. Execution
responses include the runner's student-view diagnostics as documented below.

Errors use `{"error":"message"}`:

- Missing or invalid credentials: HTTP 401 (a verified user without a profile gets 403).
- Invalid lab UUID: HTTP 400, `{"error":"Invalid lab ID"}`.
- Unknown or inaccessible lab UUID: HTTP 404, `{"error":"Lab not found"}`.
- Database failure: HTTP 500 with a generic error message.

These routes reuse `DATABASE_URL` and `SUPABASE_URL` from `.env.local`.
Apply the course migration above before using the updated lab routes.

## Run a lab

`POST /api/labs/{id}/run` requires authentication and accepts only
`{"code":"Python source from the student's editor"}`. Enrolled students and the
course's teacher can run a lab. The backend fetches the complete `tests` text from Postgres and
sends `{code, tests}` to the runner's `/run?view=both` endpoint and returns only
the student view (plus the saved `attempt_id`). It does not use
the stored starter or reference solution as the submitted code.

Configure these server-only variables in `.env.local`, then restart the backend:

- `RUNNER_URL`: runner origin, including the port if needed, for example
  `http://localhost:8081`. Do not include `/run` or query parameters.
- `RUNNER_INTERNAL_KEY`: sent as `X-Internal-Key` when configured. The provided
  runner reference does not establish whether the server enforces this header;
  confirm that with the runner maintainer. Leave empty only for a runner that
  does not require a key.

Existing `DATABASE_URL` and `SUPABASE_URL` remain required. `.env.example`
contains empty placeholders; never put runner credentials in frontend variables.

```bash
curl -i "http://localhost:3000/api/labs/$LAB_ID/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary '{"code":"def add(a, b):\n    return a + b\n"}'
```

Example HTTP 200 for a lab with two passing tests:

```json
{
  "status": "ok",
  "results": [
    {"name": "Test 1", "passed": true, "error": null},
    {"name": "Test 2", "passed": true, "error": null}
  ],
  "score": 100,
  "ran": 2,
  "passed": 2,
  "failed": 0,
  "total": 2,
  "stdout": "",
  "stdout_truncated": false,
  "duration_ms": 12,
  "tests": [
    {"index": 1, "name": "test_positive", "display_name": "Positive numbers", "status": "passed", "passed": true, "duration_ms": 1, "expected": "5", "actual": "5"},
    {"index": 2, "name": "test_negative", "display_name": "Negative numbers", "status": "passed", "passed": true, "duration_ms": 1, "expected": "-5", "actual": "-5"}
  ]
}
```

`status` extends the planned response so the frontend can distinguish `ok`,
`syntax_error`, `runtime_error`, `timeout`, and `oom`, including when no tests
finish. HTTP 200 means execution was processed, not that the code passed.
The compatibility `results` array uses fixed messages (`Test failed`,
`Test timed out`, or `Test was not run`) and generated labels. The `tests` array
contains the runner's actual labels and detailed diagnostics.

Run and Submit now include the complete documented CodeRunner student-view
output: `tests`, stdout, truncation flags, timings, expected/actual values,
exception messages, traceback frames, and available syntax-error details. The
compact `results` array remains for older clients. Test inputs and answers in
runner diagnostics are intentionally visible to the student. See the
[runner-output contract](docs/frontend-runner-output.md) for types and console
rendering. Network and infrastructure error bodies remain filtered.

Limits and errors (`{"error":"message"}`):

- `400`: invalid lab UUID or malformed JSON.
- `401` / `403`: authentication/profile errors from the existing auth helper.
- `404`: lab does not exist.
- `413`: JSON request exceeds 512 KiB, code exceeds 64 KiB in UTF-8, or the
  serialized code/tests request exceeds the runner's 512 KiB limit.
- `415`: request is not `application/json`.
- `422`: missing/empty/non-string code, extra fields, stored tests exceed 64 KiB,
  or the runner reports `ok` with zero discovered tests.
- `429`: runner queue is busy; retry later.
- `500`: database/backend failure.
- `502`: runner failure or an invalid/inconsistent response. Upstream error
  bodies are never forwarded.
- `503`: missing/invalid runner configuration or unavailable runner service.
- `504`: runner HTTP request exceeded 30 seconds, allowing for the documented
  10-second queue wait plus 6-second execution deadline. No automatic retries.

Uploads allow 1 MiB for instructions and 64 KiB each for starter, tests, and
reference solution. Before saving, `POST /api/labs` calls CodeRunner `/validate`
with the reference solution and tests. At least one test must run and all must
pass. Invalid labs return `422 LAB_VALIDATION_FAILED` with teacher diagnostics;
runner outages return separate service errors. Warning-only validation passes.

Apply `db/migrations/20261127_004_lab_validation.sql` before deploying this upload
flow. A saved lab returns `{id, validated_at, validation}` and records a compact
validation summary. Existing labs remain unvalidated (NULL audit fields). Only
the course owner receives audit fields in lab detail responses; student APIs
do not expose teacher diagnostics or warnings. See the
[teacher validation contract](docs/frontend-lab-validation.md) for exact types,
error handling, UI behavior, and integration checks.

The current CodeRunner requires `unittest.TestCase` methods. Bare functions and
the old `expect(...)` format are incompatible. A compatible complete test file is:

```python
import unittest
from solution import add

class TestAdd(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(add(2, 3), 5)

    def test_negative(self):
        self.assertEqual(add(-1, -4), -5)
```

Processed student runs are saved with submitted code, complete runner output,
compact results, counts, status, and server time before HTTP 200 is returned.
Apply `db/migrations/20261128_001_runner_output.sql` after the lab-validation
migration. Older records retain their compact output because discarded details
cannot be recovered. Teacher preview executions
create no student submissions. A storage failure returns HTTP 500 even if
execution finished. Retrying Run performs a new execution and saves a new
submission. The runner's Docker isolation and internal-key enforcement must be
verified against its deployment separately.

## Final submissions

Labs support configurable maximum accepted submissions: 1, 2, 3, or another
positive integer; NULL means unlimited. The first accepted final counts toward
the limit. Unfinished work saved with Submit anyway also counts; rejected
ordinary submissions and practice runs do not.

Apply `db/migrations/20261127_002_final_submissions.sql` after the integrity
migration, then `db/migrations/20261127_003_submission_limits.sql`. Existing
stored runs receive `kind=practice`. Existing false policies become a limit of
1; existing true policies remain unlimited. Upload `max_submissions` as a
positive integer text field or `unlimited`.

- `PATCH /api/labs/{id}` lets the course owner change the limit with JSON
  `{"max_submissions":3}` (or null for unlimited). Lowering a limit preserves
  accepted versions and floors remaining allowance at zero.

- `POST /api/labs/{id}/submit` freshly verifies student code. It requires a UUID
  `Idempotency-Key` header and JSON `{code, submit_anyway?: boolean}`. HTTP 200
  returns `{accepted,submission_id,submitted_at,submit_anyway,submission_status,execution}`.
- `GET /api/labs/{id}/submission` returns the student's current accepted status,
  policy, accepted count, remaining allowance, version, and SHA-256 digest.
- `GET /api/courses/{courseId}/students/{studentId}/report` gives the course owner
  per-lab practice counts, latest accepted finals, and current integrity.
- `GET /api/submissions/{submissionId}` lets the course owner inspect an accepted
  version's exact source and saved execution results, including full diagnostics
  for new records.

Ordinary Submit requires `status=ok`, `total>0`, and `passed=total`; failures
return `accepted=false` without consuming the allowance. With
`submit_anyway: true`, processed failures are saved as `pending_review`, consuming
one slot. Passing finals are labeled `passed`. Service errors and `ok` results
with zero tests never create a final. Apply `20261128_002_submit_anyway.sql` after
the runner-output migration before deploying this support. Teacher reports and
code inspection include the status; automatic test scores remain separate from
teacher grading (no grade-entry endpoint is added). Accepted versions are
preserved and the highest version is current. The backend and database enforce
the accepted-submission limit, including concurrent requests.
Practice runs remain unlimited. Teacher preview runs create no student record.

Idempotent replay precedes the submission-lock check. A repeated key/source/mode
returns its original committed outcome. Different source or mode under that key produces
`409 IDEMPOTENCY_KEY_REUSED`. Concurrent operations for one student/lab produce
`409 SUBMISSION_PROCESSING` with `Retry-After: 2`. A new action on a locked lab
returns `409 FINAL_SUBMISSION_LOCKED` for a limit of 1, or
`409 SUBMISSION_LIMIT_REACHED` for a larger exhausted limit. Committed rejections
still replay after a policy increase; a new action needs a new key.

Accepted rows and outcomes commit atomically. Uncommitted execution may repeat
after a crash or save failure. A committed outcome replays after response loss.
The existing report categorizes records as `practice` or `final`, preserves
timelines, and labels integrity as `current_lab`. No submission-time integrity
snapshot is recorded.

The [frontend final-submission guide](docs/frontend-final-submissions.md)
contains exact types, submission-limit controls, pending-action persistence,
retry logic, digest comparison, error codes, and curl examples.
No new environment variables are required.

Run the final-submission PostgreSQL tests explicitly. They create an isolated
temporary schema and remove it afterward. They use real SQL, transactions,
constraints, and concurrency with mocked authentication and runner HTTP.

```bash
node --env-file=.env.local --test tests/integration/final-submissions.test.mjs
```

## Integrity events and reports

Apply `db/migrations/20261127_001_integrity.sql` once after the course migration.
It adds `integrity_events` and `submissions`, with triggers rejecting updates,
deletes, and truncation. Direct browser-role privileges are revoked. Existing
course and lab content is preserved. No additional environment variables are
needed. Keep applied migration files immutable.

`POST /api/labs/{id}/events` accepts student telemetry only for enrolled courses.
It authenticates before reading the body and derives student identity from the
verified profile. Known events are validated and inserted together. Unknown
types are dropped. Batches exceeding 100 items or 64 KiB return `400`. Malformed
JSON, invalid event fields, and invalid lab IDs also return `400`. Incorrect
content type returns `415`. Inaccessible labs return `404`.

Every event requires UUID `event_id` and `session_id`. Retry the same IDs after
network failures. A unique key ignores repeated IDs for the same lab/student
without changing the original event. The backend supplies `received_at` and
uses it for ordering and scoring. Success returns an empty `204` response.

```bash
curl -i "http://localhost:3000/api/labs/$LAB_ID/events" \
  -H "Authorization: Bearer $STUDENT_TOKEN" \
  -H "Content-Type: application/json" \
  --data '[{"event_id":"2d588df5-a769-4624-b339-9ea2b68d4594","session_id":"f28fbaf6-a002-416d-980f-06d198002031","type":"paste_blocked","payload":{"chars":340},"ts":"2026-11-27T14:02:11.000Z"}]'

curl "http://localhost:3000/api/labs/$LAB_ID/report" \
  -H "Authorization: Bearer $TEACHER_TOKEN"
```

`GET /api/labs/{id}/report` is restricted to the course's teacher. It includes
enrolled students plus students with historical activity, execution summaries,
event timelines, and computed integrity scores sorted ascending. Reports omit
submitted source, test source, and reference solutions. Student assistant chats
are stored separately and are not exposed by teacher integrity reports; their
`chat_available` field remains false. Scores are computed on read and never persisted.

| Rule | Deduction |
| --- | --- |
| Blocked paste or drop | 10 per attempt, capped at 40 |
| Blocked insertion above 80 characters | 15 per attempt, capped at 30 |
| Visibility or window-focus loss | First three free, then 5 each, capped at 20 |
| First perfect run within 60 seconds of first received opening event | 20 |

Overlapping blur and hidden events count as one departure within each page
session. Send both `window_focus` and `tab_visible` when applicable to complete
the episode. Every flag includes evidence, receipt time, and its actual penalty.
The score starts at 100 and floors at zero. Missing telemetry is explicitly
identified and carries no invented deduction. Browser telemetry remains
client-reported, and delayed delivery affects the fast-pass observation.

The complete frontend contract, Monaco blocking adapter, delivery checklist,
report shape, and browser acceptance tests are in
[the frontend integrity guide](docs/frontend-integrity.md).

`npm test` covers scoring, validation, and the run handler. The PostgreSQL suite
also covers event access, atomic validation, retries, reports, append-only
triggers, and submission persistence. It rolls back all changes.

```bash
node --env-file=.env.local --test tests/integration/courses.test.mjs
```

Run backend checks with `npm test`, `npm run lint`, and
`npx tsc --noEmit --incremental false`. The tests exercise the real run handler
and runner adapter with mocked auth, database, and HTTP boundaries; they do not
verify the live Docker service.

## Upload and run the new demo

`demo-lab-unittest/` contains four ready-to-upload files for **Sum Positive
Numbers**: `instructions.md`, `starter.py`, `tests.py`, and `solution.py`.
The test file contains six discoverable `unittest.TestCase` methods.

From the backend directory, use a teacher access token as `TOKEN` and the ID of
a course owned by that teacher as `COURSE_ID`:

```bash
curl -i http://localhost:3000/api/labs \
  -H "Authorization: Bearer $TOKEN" \
  -F "course_id=$COURSE_ID" \
  -F 'title=Sum Positive Numbers' \
  -F 'max_submissions=1' \
  -F 'instructions=@demo-lab-unittest/instructions.md' \
  -F 'starter=@demo-lab-unittest/starter.py' \
  -F 'tests=@demo-lab-unittest/tests.py' \
  -F 'solution=@demo-lab-unittest/solution.py'
```

Expected: HTTP `201` with `{id, validated_at, validation}` after reference tests
pass and the lab is saved. Set `LAB_ID` to the returned ID.
The frontend upload form sends the same fields using `FormData`, with the four
files selected separately; let the browser set the multipart Content-Type.

Open the new lab in the frontend and run the starter. It should discover six
tests and fail all six (`status: "ok"`, `score: 0`, `passed: 0`, `total: 6`).
For a passing smoke check, run:

```bash
curl -i "http://localhost:3000/api/labs/$LAB_ID/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"code":"def sum_positive(numbers):\n    return sum(n for n in numbers if n > 0)\n"}'
```

Expected: HTTP `200`, `status: "ok"`, `score: 100`, `passed: 6`, `total: 6`,
and six passing entries in `results`. Teachers can run their own labs. To test
as a student, enroll that student in the course and use their access token.
The local runner must be running at the origin configured by `RUNNER_URL`.

If you see `This lab has no runnable unittest tests`, the runner discovered
zero tests in the **stored** test file. Legacy labs may contain incompatible
test files; new uploads are rejected by reference validation when no tests are
discovered. Retrying identical student code will not repair an incompatible test file.

Fixing a local file does not change an already-uploaded lab. Upload the corrected
four files as a **new lab** and open the new ID. The lab PATCH endpoint updates
the submission limit only; it does not replace uploaded files. Existing database
labs are not modified by these demo changes.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.


## Student AI assistant

Apply `20261128_003_ai_chat.sql`, then `20261128_004_stateful_tutor.sql` after
Submit anyway. Stop/drain old workers first; the protocol migration refuses
active processing turns. Configure server-only `TUTOR_API_URL` and the deployed
Caddy `TUTOR_API_TOKEN`. The runner must support `view=both`.

Students create/list lab conversations and post to
`/api/conversations/{conversationId}/messages`. The backend stores browser-visible
messages and exact execution snapshots. The AI owns model history in SQLite:
**set `MAX_HISTORY_TURNS=3` on the AI server** to retain three question/answer
exchanges. The backend no longer queries/sends `recent_messages`.

Lab context is sent initially and when updated, from trusted lab records. Each
backend turn UUID is forwarded as the AI Idempotency-Key. Uncertain outcomes block
new messages until the turn is recovered. POST
`/api/conversations/{conversationId}/turns/{turnId}/recover` recovers using the
saved snapshot, even after browser storage loss. DELETE
`/api/conversations/{conversationId}` coordinates remote/local cleanup. Reset
creates a fresh conversation UUID after cleanup. Old protocol-1 conversations
remain readable but cannot receive new questions.

Student Run exposes `attempt_id`; accepted final IDs can also select context.
Private tutor/lab context stays server-side. Different students can chat in
parallel; leases, rate limits, and recovery are coordinated through PostgreSQL.

See [the frontend AI assistant contract](docs/frontend-ai-assistant.md) for routes,
frontend changes, migration, configuration, and recovery/deletion semantics.
Database verification (isolated schema, simulated stateful AI):

```bash
node --env-file=.env.local tests/integration/chat.test.mjs
```
