# Final submissions and frontend integration

The backend implements the contracts in this document. Apply
`db/migrations/20261127_002_final_submissions.sql`, then
`db/migrations/20261127_003_submission_limits.sql` after the course and integrity
migrations before serving these routes. Check the implementation handoff for
actual migration and verification results.

## Teacher submission limit

Use a **Maximum accepted submissions** control with positive integer choices
such as 1, 2, or 3, plus Unlimited. The limit includes the first accepted final;
3 permits three accepted versions, not three additional resubmissions. Failed
executions and practice runs do not consume this allowance.

For uploads, send exactly one multipart text field `max_submissions`: a decimal
integer from `"1"` through `"2147483647"`, or `"unlimited"`. Missing policy,
repeated fields, files, zero, negative/fractional values, and malformed text
produce `422 {"errors":[...]}`. JSON reads represent unlimited as `null`.

For compatibility, uploads may instead send the old `allow_resubmissions` text
field: `"false"` maps to 1 and `"true"` maps to unlimited. If both fields are
sent, they must agree. The boolean remains in responses, but use `can_submit`
and `remaining_submissions` to control student actions; a finite limit greater
than 1 also has `allow_resubmissions: true`.

```ts
const form = new FormData()
form.set("course_id", courseId)
form.set("title", title)
form.set("max_submissions", maxSubmissions === null ? "unlimited" : String(maxSubmissions))
form.set("instructions", instructionsFile)
form.set("starter", starterFile)
form.set("tests", testsFile)
form.set("solution", solutionFile)
await fetch("/api/labs", {
  method: "POST",
  headers: { Authorization: `Bearer ${await getAccessToken()}` },
  body: form,
})
```

Allow the browser to set the multipart content type and boundary. Migration
preserves existing policy: false becomes 1 and true becomes unlimited. Labs
that predate final submissions default to 1. Both lab details and submission
status return `max_submissions`.

To update an existing lab, its course owner sends:

```http
PATCH /api/labs/{id}
Authorization: Bearer <token>
Content-Type: application/json

{"max_submissions":3}
```

Send JSON `null` for unlimited. HTTP 200 returns
`{id: string, max_submissions: number | null, allow_resubmissions: boolean}`.
The JSON body accepts only this field. Errors use `{error: string}` with `400`
for an invalid ID/JSON, `401` for missing/invalid auth, `403` for students, `404`
for missing labs or another teacher's lab, `413` for oversized bodies, `415`
for wrong content type, `422` for an invalid limit/body shape, and `500` for
service/database failures. Updates wait for an active final transaction to
finish, so verification and saving use one stable policy.

Increasing the limit opens additional slots. Lowering it never removes earlier
versions; remaining allowance floors at zero. A previously committed limit
rejection still replays after an increase: use a new key for a new action.

## Routes

All routes require a Supabase bearer token. Course enrollment and owner checks
are enforced in the backend. UUID path parameters are validated. Authenticated
reads and Submit responses use `Cache-Control: private, no-store`.

| Route | Role and request | Success |
| --- | --- | --- |
| `PATCH /api/labs/{id}` | Course owner; JSON `{max_submissions: number \| null}` | `200 {id, max_submissions, allow_resubmissions}` |
| `POST /api/labs/{id}/run` | Enrolled student or course owner; JSON `{code}` | `200 ExecutionResult` |
| `POST /api/labs/{id}/submit` | Enrolled student; JSON `{code}` and UUID `Idempotency-Key` header | `200 SubmitResult` |
| `GET /api/labs/{id}/submission` | Enrolled student; no body | `200 SubmissionStatus` |
| `GET /api/courses/{courseId}/students/{studentId}/report` | Course owner; no body | `200 StudentCourseReport` |
| `GET /api/submissions/{submissionId}` | Course owner; accepted final ID | `200 SubmittedCode` |
| `GET /api/labs/{id}/report` | Course owner | Existing event timeline plus categorized attempts and latest accepted final |

`GET /api/labs/{id}` includes `max_submissions` and `allow_resubmissions` with the existing instructions,
source and integrity policy. The source limit is 65,536 UTF-8 bytes. JSON request
bodies are bounded at 524,288 bytes. Submit accepts exact, nonempty Unicode source
without null characters. It preserves whitespace and indentation.

## Response types

```ts
type ExecutionResult = {
  status: "ok" | "syntax_error" | "runtime_error" | "timeout" | "oom"
  results: Array<{ name: string; passed: boolean; error: string | null }>
  score: number
  passed: number
  total: number
}

type SubmitResult =
  | { accepted: true; submission_id: string; submitted_at: string; execution: ExecutionResult }
  | { accepted: false; submission_id: null; submitted_at: null; execution: ExecutionResult }

type AcceptedSubmission = {
  submission_id: string
  submitted_at: string
  version: number
  code_sha256: string
  execution: ExecutionResult
}

type SubmissionStatus = {
  lab_id: string
  allow_resubmissions: boolean
  max_submissions: number | null
  accepted_submission_count: number
  remaining_submissions: number | null // null means unlimited
  can_submit: boolean
  accepted_submission: AcceptedSubmission | null
}

type SubmittedCode = AcceptedSubmission & {
  lab_id: string
  student_id: string
  code: string
}

type IntegritySummary = {
  score: number
  penalty: number
  penalties: { paste: number; large_insert: number; focus: number; fast_pass: number }
  badge: "green" | "amber" | "red"
  flags: Array<{ type: string; evidence: string; at: string; penalty: number }>
  focus_losses: number
  telemetry_status: "recorded" | "missing_lab_opened" | "missing"
}

type StudentCourseReport = {
  course_id: string
  student: { id: string; email: string; full_name: string | null }
  labs: Array<{
    lab_id: string
    title: string
    allow_resubmissions: boolean
    max_submissions: number | null
    accepted_submission_count: number
    remaining_submissions: number | null
    practice_attempt_count: number
    accepted_submission: AcceptedSubmission | null
    integrity_scope: "current_lab"
    integrity: IntegritySummary
  }>
}
```

The status route reports the highest accepted version. `can_submit` reflects the
resubmission policy and accepted history; an in-progress request can still cause
a temporary processing response. The teacher code route returns the exact code
verified for the selected version. Students use the digest to compare editor
content after reload. Teacher-only source retrieval stays restricted to the owner.

In the existing lab report, every `students[].submissions[]` entry now includes
`kind: "practice" | "final"`, `version`, `code_sha256`, and sanitized `results`.
Practice entries have null version/digest. Each student also has
`practice_attempt_count`, `accepted_submission`, and
`integrity_scope: "current_lab"`. Existing event timelines remain available.
The report's top level includes `allow_resubmissions` and `max_submissions`.
Each student also has `accepted_submission_count` and `remaining_submissions`.

## Student page flow

1. Load the lab and `GET /api/labs/{id}/submission` together. Keep the Submit
   control in a loading state until accepted status is known. Show Run separately.
2. If accepted status is present, display its version and server timestamp.
   If `can_submit` is false, disable new Submit actions and show **Submitted**.
   Practice editing and Run remain available.
3. If `can_submit` is true, label the action **Submit** or **Submit another version**
   according to whether an accepted version exists.
4. On Submit, capture `guard.getAcceptedCode()` once. Attempt a telemetry flush.
   Generate one UUID key and durably save that key and exact code snapshot before
   sending. Disable duplicate clicks while the request is outstanding.
5. For HTTP 200, inspect `accepted`. If false, show the execution failure and allow
   editing followed by a new action/key. If true, show the saved version by
   refreshing submission status. A prior accepted version remains visible when
   a permitted later attempt fails.
6. On network loss, `500`, or `SUBMISSION_PROCESSING`, retain the saved request.
   Recover by sending its original key and original code. The current editor may
   have changed, so recovery must use the saved snapshot.
7. After reload, load accepted status and unresolved local requests. Offer
   **Recover pending submission** for each unresolved action. Recovery remains
   available even when `can_submit` is false because a successful original key
   must replay after locking.
8. After a terminal outcome, remove only that action's saved record. Refresh
   status after both accepted outcomes and locked responses.

Persist each pending action under a separate key containing user ID, lab ID,
and action UUID. This avoids one tab overwriting another tab's request. Recover
only requests belonging to the current signed-in user. Handle unavailable/full
storage visibly before starting a request that cannot be preserved for recovery.

```ts
type PendingSubmission = { key: string; code: string }

function pendingStorageKey(userId: string, labId: string, key: string) {
  return `final-submission:${userId}:${labId}:${key}`
}

function beginSubmission(userId: string, labId: string, code: string): PendingSubmission {
  const pending = { key: crypto.randomUUID(), code }
  localStorage.setItem(pendingStorageKey(userId, labId, pending.key), JSON.stringify(pending))
  return pending
}

async function sendSubmission(
  userId: string,
  labId: string,
  pending: PendingSubmission,
  getAccessToken: () => Promise<string>,
) {
  // Both a new action and recovery call this same function.
  const response = await fetch(`/api/labs/${labId}/submit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
      "Idempotency-Key": pending.key,
    },
    body: JSON.stringify({ code: pending.code }),
  })
  const body = await response.json()
  if (response.status === 200 || body.code === "FINAL_SUBMISSION_LOCKED" || body.code === "SUBMISSION_LIMIT_REACHED") {
    localStorage.removeItem(pendingStorageKey(userId, labId, pending.key))
  }
  return { status: response.status, body, retryAfter: response.headers.get("Retry-After") }
}
```

On an exception, keep the persisted action and show delivery uncertainty. On
`401`, refresh the existing auth session and retry that action. A status lookup
showing an accepted version does not prove which pending key created it; replay
the key to resolve its outcome. API results must be validated by the frontend's
normal response handling before displaying them.

## Compare editor content after reload

Hash the exact accepted editor value using UTF-8 and SHA-256. Compare the lowercase
hex digest to `accepted_submission.code_sha256`. Preserve line endings and
whitespace. Use the exact string supplied to Submit.

```ts
async function codeDigest(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const snapshot = guard.getAcceptedCode()
const digest = await codeDigest(snapshot)
// Discard this comparison if editor content changed while hashing.
if (guard.getAcceptedCode() === snapshot && status.accepted_submission) {
  const hasChanges = digest !== status.accepted_submission.code_sha256
  setHasChangesSinceSubmission(hasChanges)
}
```

Load the initial editor from the existing starter/saved-editor workflow.
Submission status provides a comparison digest; restoring accepted source to the
student editor is outside this endpoint's response.

## Idempotency, concurrency and recovery guarantees

The key is scoped to authenticated student and lab and bound to exact source.
JSON formatting outside `code` does not change payload identity. Upper/lowercase
UUID spellings refer to the same key. A committed result is immutable.

- Same key and source replays the original status and response, including a
  failed execution or locked outcome. Replaying an older accepted version after
  later versions returns that older action's original result.
- Same key with different source returns `409 IDEMPOTENCY_KEY_REUSED`.
- One final operation at a time can execute for a student/lab. A competing key
  or duplicate key receives `409 SUBMISSION_PROCESSING` and `Retry-After: 2`.
  Retry with backoff and the same key. Practice runs use their existing path.
- With a finite limit, new final actions stop when the accepted count reaches
  `max_submissions`. Replay is checked first and does not consume another slot.
  Failed executions do not consume a slot. NULL permits unlimited accepted finals.
- Each newly accepted action creates an append-only version. A database-assigned
  increasing integer determines latest. Concurrent requests cannot exceed the limit.
- The accepted row and replayable outcome commit in one transaction. If the
  response or commit acknowledgement is lost after commit, retry replays it.
- If execution finishes but the transaction rolls back or its connection/process
  dies before commit, the key/source binding remains. Retry executes again.
  Only the committed outcome is replayable. Execution itself is not guaranteed
  exactly once across crashes or storage failures.
- Request/service errors have no committed outcome and can be retried with the
  same bound key/source after recovery. Zero discovered tests return `422` and
  never create an accepted final.

## Errors

Submit-specific errors use `{error: string, code: string}`. Authentication errors
from the shared helper use `{error: string}`.

| HTTP | Code | Frontend behavior |
| --- | --- | --- |
| `400` | `INVALID_LAB_ID` | Fix the lab reference |
| `400` | `INVALID_IDEMPOTENCY_KEY` | Supply one UUID header |
| `400`, `413`, `415`, `422` | `INVALID_REQUEST` | Show validation feedback; fix the source/request before a new action |
| `401`, `403` | Shared auth response | Refresh login or show role restriction; keep pending recovery data |
| `404` | `LAB_NOT_FOUND` | Refresh enrollment/access |
| `409` | `IDEMPOTENCY_KEY_REUSED` | Recover the original payload/key; do not silently replace the key |
| `409` | `SUBMISSION_PROCESSING` | Retry the same action after `Retry-After`, with backoff |
| `409` | `FINAL_SUBMISSION_LOCKED` | Refresh status and disable new final actions |
| `409` | `SUBMISSION_LIMIT_REACHED` | Limit greater than 1 is exhausted; refresh status |
| `413`, `422`, `429`, `502`, `503`, `504` | `EXECUTION_SERVICE_ERROR` | Show the server message; preserve the pending request for recovery |
| `500` | `SUBMISSION_SAVE_FAILED` | Outcome may be uncertain; retry the same key and code |

HTTP 200 with `accepted: false` is a processed execution outcome. Render its
structured syntax/runtime/timeout/OOM or failed-test results. The existing Run
error contract and response shape remain compatible.

The three new GET routes return `{error: string}` for failures: `400` for an
invalid UUID, `401` for missing/invalid authentication, `403` for the wrong role,
`404` for an absent or inaccessible resource, and `500` for an authentication
service or database failure. Submit can also return the shared authentication
helper's `500 {error: string}` before it reaches submission processing.

## Migration order

Apply each migration once, in this order, to the existing application schema:

1. `20261126_001_courses.sql`: courses, enrollments, and lab/course ownership.
2. `20261127_001_integrity.sql`: append-only events and stored executions.
3. `20261127_002_final_submissions.sql`: lab resubmission setting, practice/final
   classification, source-bound idempotency requests, replayable outcomes,
   version/digest columns, final-validity constraints, and concurrency guards.
4. `20261127_003_submission_limits.sql`: positive nullable `max_submissions`,
   legacy-policy backfill, consistency constraint, and numeric database guard.

Old executions remain practice attempts. Existing false policies become a
limit of 1; true policies become unlimited. No accepted versions are removed.
The integration suite applies migrations to an isolated test schema; passing it
does not apply it to the application's public schema.

## Teacher workflow

Open the course roster, select a student, then fetch the course-student report.
Each course lab has practice counts, the latest accepted final and its execution
summary, and current integrity. This includes historical students with recorded
activity in that course. Labs and activity from other courses are excluded.

Open **View submitted code** using the accepted submission ID. Show its version,
server timestamp, exact code and verified test results in a read-only viewer.
Older accepted versions remain inspectable through IDs in the existing lab
report. Practice IDs return `404` from this accepted-code endpoint.

Label integrity **Current lab integrity score**. It is recomputed from current
server-received activity and may change after delayed telemetry. No immutable
submission-time integrity score is stored. `first_pass_at` continues to reflect
the earliest perfect execution across practice and final records. Test score
and integrity score have distinct labels. Follow
[the integrity guide](frontend-integrity.md) for telemetry collection and timelines.

`telemetry_status: "recorded"` means a lab-open event was received, not that
every browser event was delivered. Missing telemetry can still yield a numeric
score of 100, so show the telemetry status alongside the score. The backend
cannot independently observe pastes or tab switches; the frontend must collect
and deliver them. These flags describe observed activity, not proof of cheating.

## Curl examples

```bash
curl -i "http://localhost:3000/api/labs/$LAB_ID/submit" \
  -H "Authorization: Bearer $STUDENT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $SUBMISSION_KEY" \
  --data-binary '{"code":"def add(a, b):\n    return a + b\n"}'

curl "http://localhost:3000/api/labs/$LAB_ID/submission" \
  -H "Authorization: Bearer $STUDENT_TOKEN"

curl "http://localhost:3000/api/courses/$COURSE_ID/students/$STUDENT_ID/report" \
  -H "Authorization: Bearer $TEACHER_TOKEN"

curl "http://localhost:3000/api/submissions/$SUBMISSION_ID" \
  -H "Authorization: Bearer $TEACHER_TOKEN"
```

## Verification checklist

- Upload limits 1, 2, 3 and Unlimited; verify lab details and status agree.
- Run repeatedly before and after exhausting the accepted-submission allowance.
- Fail Submit, edit, then succeed with a new key on a locked-by-policy lab.
- Retry that accepted key and recover the original response after reload.
- Try a different key after exhausting the allowance; expect locked/limit reached.
  Increase the limit and use a new key; verify old versions remain inspectable.
- Submit concurrently from two tabs, with both identical and different keys.
- Exercise uncertain network outcomes without changing the captured payload.
- Compare the digest after reload, including whitespace and Unicode changes.
- Confirm students and unrelated teachers cannot inspect accepted code.
- Confirm reports keep practice counts separate and include current integrity.
- Run browser tests in the actual frontend alongside backend integration tests.
