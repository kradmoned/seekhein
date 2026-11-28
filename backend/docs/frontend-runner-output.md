# Complete student runner output

Student Run and Submit now return all documented fields from CodeRunner's
`student` member of the runner's `/run?view=both` response. The old compact `results` array is retained for
compatibility. Read `tests`, `stdout`, and `syntax_error` for the console UI.

This intentionally exposes test labels, inputs, expected/actual values, exception
messages, student-code traceback frames, and captured output when the runner
provides them. Do not assume those values are confidential. Reference solution
and test source files are still not returned. The backend does not switch to
`view=tutor` or `view=full`; tutor-only fields are saved server-side and are not
forwarded to the browser. Student Run also returns `attempt_id` for chat context
selection; teacher previews return `attempt_id: null`. See the
[AI assistant contract](frontend-ai-assistant.md).

## Response type

```ts
type ExecutionSummary = {
  status: "ok" | "syntax_error" | "runtime_error" | "timeout" | "oom"
  results: Array<{ name: string; passed: boolean; error: string | null }>
  score: number
  passed: number
  total: number
}

type ExecutionResult = ExecutionSummary & {
  ran: number
  failed: number
  stdout: string
  stdout_truncated: boolean
  duration_ms: number
  tests: Array<{
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
    traceback?: Array<{ line: number; function: string; code: string }>
    stdout?: string
    stdout_truncated?: boolean
  }>
  syntax_error?: {
    error_type: string
    error_message?: string
    line: number
    code_line?: string
  }
}
```

The backend validates field types and test-count/score consistency but does not
rewrite the documented diagnostic values. It drops unknown fields and retains
the existing 1-MiB runner-response bound. Optional fields are absent when the
runner omits them; the backend does not invent tracebacks or messages. For
example, an import-time runtime error may provide only status and stdout in
student view. Errors originating in the test suite may lack `syntax_error`.

## Endpoint behavior

| Endpoint | Response |
| --- | --- |
| `POST /api/labs/{id}/run` | HTTP 200 with `ExecutionResult` plus `attempt_id: string \| null` |
| `POST /api/labs/{id}/submit` | Existing wrapper; `execution` contains `ExecutionResult` |
| `GET /api/labs/{id}/submission` | Accepted submission's `execution` contains the saved full output for new records |
| `GET /api/submissions/{submissionId}` | Owner-only exact code plus the saved full execution output for new records |

Teacher preview Run responses also have the full fields, without creating a
student record. Course-student overviews and lab activity timelines continue to
use compact execution summaries rather than embedding every run's console log.

Execution failures such as syntax errors, failed assertions, timeout, and OOM
still produce HTTP 200 on Run. Ordinary Submit wraps them with `accepted: false`.
With `submit_anyway: true`, Submit saves them with `accepted: true` and
`submission_status: "pending_review"`; see the [submission contract](frontend-final-submissions.md#submit-anyway-button).
The existing exceptions remain: runner `internal_error` becomes HTTP 502;
`status: "ok"` with zero tests becomes HTTP 422. Network, malformed-response,
validation, access, and service-error contracts remain unchanged. Raw HTTP
infrastructure error bodies are never forwarded.

## Console rendering

- Show root `stdout` for output captured during imports/setup.
- Show `tests[i].stdout` alongside each test; do not overlook this separate stream.
- Use `display_name` for the label and `error_type` / `error_message` for errors.
- Display traceback frames using their line, function, and source-code fields.
- For `syntax_error`, display the message, line, and code snippet, even if
  `tests` is empty.
- Show truncation indicators when either `stdout_truncated` flag is true.
- Render all text as escaped text or text nodes, never HTML. Output may contain
  arbitrary student-printed characters, including null characters.
- The retained `results` array still uses generated labels and generic errors;
  it is for older clients, not the detailed console.

An individual test can fail while the top-level status remains `ok`. Use
`passed`/`total` or individual test statuses to display the outcome.

## Storage and older records

Apply `db/migrations/20261128_001_runner_output.sql` after the existing migrations.
New practice and accepted-final records store the complete execution response in
`submissions.execution_output`, attached to the exact executed source. Failed
final executions are retained in their existing idempotency outcomes. Retries
replay the stored response, including diagnostics.

The migration uses PostgreSQL JSON for complete output and replay bodies so
escaped null characters survive storage. Existing compact result columns remain
unchanged. Existing records have NULL `execution_output`; old accepted status,
inspection, and previously committed idempotency responses retain their compact
shape. Previously discarded diagnostics cannot be reconstructed. Frontends
reading historical records should accept `ExecutionSummary | ExecutionResult`
and fall back to `results` when `tests` is absent.

No new chat functionality or student practice-history endpoint is introduced.

## Verification

```bash
npm test
npm run lint
npx tsc --noEmit --incremental false
node --env-file=.env.local tests/integration/final-submissions.test.mjs
node --env-file=.env.local tests/integration/courses.test.mjs
node --env-file=.env.local tests/integration/runner-output.test.mjs
```

The last command uses synthetic code against the configured live runner and
creates no application database records.
