# Student lab assistant: backend/frontend contract

The backend owns conversation history and execution selection. The AI service is
stateless: every request includes the **last three completed exchanges** (three
student questions and three assistant answers), followed by the new question in
its separate `message` field. This is six prior messages, not three messages.

## Deployment

Apply `db/migrations/20261128_003_ai_chat.sql` after `20261128_002_submit_anyway.sql`.
The migration preserves historical submissions, adds nullable server-only
`tutor_output`, and creates `chat_conversations`, `chat_turns`, `chat_messages`,
and `chat_dispatches`. Existing execution records keep NULL tutor output.

Configure `TUTOR_API_URL` as a reachable HTTP(S) origin, for example
`http://127.0.0.1:8000` only when the backend can reach that machine's service.
The backend calls `/api/v1/tutor`. No URL is hard-coded. An optional
`TUTOR_API_TOKEN` sends a server-side Bearer token if a deployed gateway supports
that authentication method. The supplied FastAPI contract does not require a
token; confirm deployment authentication separately. Never expose this token to
the frontend. Check the AI service's `GET /health` during deployment.

The runner must support **`POST /run?view=both`**, already implemented in the
repository's `runner/cmd/runner/main.go`. It returns `{student,tutor}` from a
single execution. Deploy that runner version before deploying this backend.
Run and Submit now persist the complete tutor object alongside the student
execution, without returning tutor diagnostics to the browser. No second run is
performed to obtain tutor feedback. There is no automatic fallback to an older
runner because that could execute the code again or silently lose diagnostics.

AI calls have a 45-second deadline and the message route declares a 60-second
execution budget. Configure the hosting platform to support this budget. Database
leases last 120 seconds, so a terminated worker can be recovered without leaving
a conversation permanently locked. In-flight operations occupy no database
transaction while waiting for the AI.

## Authentication and routes

All routes require `Authorization: Bearer <Supabase access token>`, a student
role, and current enrollment in the conversation's lab course. Each conversation
belongs to one student and one lab. Teachers and other students cannot read it.
Authenticated responses use `Cache-Control: private, no-store`.

| Route | Success |
| --- | --- |
| `POST /api/labs/{labId}/conversations` (no body) | `201 {conversation_id, lab_id, created_at, updated_at}` |
| `GET /api/labs/{labId}/conversations?after=0&limit=20` | `200 {conversations: [...], next_after: number \| null}` |
| `POST /api/conversations/{conversationId}/messages` | `200 ChatReply` |
| `GET /api/conversations/{conversationId}/messages?after=0&limit=20` | `200 ChatHistory` |

Conversation listing is newest-created first; `after` is a numeric offset.
Message history is paginated by **whole turns**, oldest first; `after` is a turn
sequence. Use `next_after` to fetch the next page. Limits are 1–50 (default 20).
A conversation creation is not idempotent; if its response is lost, list existing
conversations before creating another. Creation is limited to 20 per student per
hour. Reuse conversations when restoring a lab page.

## Asking a question

```http
POST /api/conversations/{conversationId}/messages
Authorization: Bearer <student-token>
Content-Type: application/json
Idempotency-Key: <UUID generated once for this question>

{"message":"Why does my loop stop?","current_code":"def f(xs):\n    for x in xs:\n        return x\n","attempt_id":null}
```

```ts
type ChatInput = {
  message: string        // non-whitespace, <= 8 KiB UTF-8
  current_code: string | null // required key, <= 64 KiB UTF-8; empty string allowed
  attempt_id?: string | null // saved execution UUID; omission/null means latest saved
}
type ChatReply = {
  conversation_id: string
  turn_id: string
  student_message_id: string
  assistant_message_id: string
  answer: string
  sources: unknown[]
}
type ChatHistory = {
  conversation_id: string
  turns: Array<{
    turn_id: string
    sequence: number
    idempotency_key: string
    attempt_id: string | null
    status: "processing" | "completed" | "failed"
    error_code: string | null
    created_at: string
    completed_at: string | null
    messages: Array<{
      id: string
      role: "user" | "assistant"
      content: string
      sources: unknown[]
      created_at: string
    }>
  }>
  next_after: number | null
}
```

The request accepts only those three JSON fields and is limited to 512 KiB.
NUL characters and malformed Unicode in message/code are rejected. Never send
browser-supplied history, student identity, scenario, tests, or execution results.

A successful reply means the assistant answer and completed turn were committed
to the database. The frontend displays `answer`. Treat `sources` as optional
learning-material metadata with no fixed entry schema; render text safely and do
not render arbitrary source metadata as executable HTML.

## Execution context

Student Run responses retain their existing fields and add `attempt_id`, the
UUID of the persisted practice execution. Teacher preview responses have
`attempt_id: null` and still create no student execution record.

For accepted final submissions, the existing `submission_id` is also a valid
attempt ID. Ordinary rejected Submit requests do not create a submission record;
they do not provide an attempt ID. Run the current code to obtain one when the
student wants help with that code's execution.

When `attempt_id` is null/omitted, the backend selects the newest **saved** practice
or final execution for the current student and lab by server timestamp. An
explicit ID must belong to this same student and lab; other IDs return 404.
The selected ID, exact executed code, complete tutor feedback, current code, and
prior conversation messages are frozen in the turn's context snapshot. Retrying
a turn does not select a newer execution or replace its history.

`current_code` is the editor at click time; `executed_code` belongs to the chosen
run and can differ. Keep the attempt ID associated with the displayed console
result. Never label that output as belonging to edited code that has not run.
When there is no saved run, executed code and feedback are null. Historical runs
with no tutor output supply their executed code and `validation_feedback: null`.

The complete tutor payload is preserved, including diagnostic fields and future
fields, and forwarded only to the configured tutor service. The AI service is
responsible for sanitizing it before using it as model context, as specified by
its API contract. Its Socratic behavior is implemented by that service; this
backend does not rewrite answers or guarantee that the model never gives code.

## Backend-to-AI communication

The backend sends exactly these keys to `POST {TUTOR_API_URL}/api/v1/tutor`:

```json
{
  "conversation_id": "backend-conversation-uuid",
  "message": "The new student question",
  "recent_messages": [
    {"role":"user","content":"Previous question 1"},
    {"role":"assistant","content":"Previous answer 1"},
    {"role":"user","content":"Previous question 2"},
    {"role":"assistant","content":"Previous answer 2"},
    {"role":"user","content":"Previous question 3"},
    {"role":"assistant","content":"Previous answer 3"}
  ],
  "current_code": null,
  "executed_code": null,
  "output_error": null,
  "validation_feedback": null
}
```

There can be fewer than three exchanges, including none. Only completed turns
are used; failed/pending questions and the current question are excluded.
The runner has no separate output-error object, so `output_error` is null; its
runtime errors remain inside the full `validation_feedback` object. No `scenario`
field or lab reference solution is sent. No second AI call is made to classify
context.

Replies must have `status: "success"`, the exact conversation ID, a nonempty
answer (at most 32 KiB), and a sources array. Response bodies are bounded at
256 KiB. Invalid replies and upstream validation details are not passed through
to the browser. Logs contain conversation/turn IDs and safe error codes, not
message bodies, source code, test diagnostics, or credentials.

## Frontend persistence and retry flow

1. Create/select a conversation. Restore its messages using GET, fetching further
   pages as needed. Do not create a conversation on every page reload.
2. Capture message, complete editor code, and selected attempt ID once. Generate
   a UUID idempotency key and durably save that exact pending request before POST.
3. Disable another send in the same conversation until the current action resolves.
   Other conversations and other students may send simultaneously.
4. Display the saved answer on HTTP 200 and remove that pending local action.
5. On network loss or a retryable error, preserve the request. Retry the same
   conversation, key, message, code, and attempt selector. Do not use current
   editor contents in place of the saved snapshot.
6. On reload, restore history and unresolved pending requests. Completed-key replay
   resolves delivery uncertainty without calling the AI again.

Use separate local storage keys per signed-in student, conversation, and request
UUID, so tabs/users cannot overwrite one another. Handle unavailable local storage
before sending. A status/history lookup alone does not replace idempotent replay.

The same key with different code, message, or attempt selector returns 409.
Omitted and null `attempt_id` are equivalent. A completed replay still checks
current access but bypasses dispatch rate limits and missing tutor configuration.

Only one turn can process in a conversation at once, enforced across backend
workers by short database locks and a lease token. An expired worker cannot
write over a newer worker's answer. A lease-expired turn appears as failed with
`TURN_INTERRUPTED`; retrying it or starting a new turn recovers the lock.
Retrying an earlier failed turn uses its original context even if later turns
have since completed; display it at its original turn sequence.

Student questions are saved before the AI call; assistant replies and completion
state commit atomically afterward. If saving fails, the question remains visible
as a failed/incomplete turn. If commit succeeds but delivery fails, replay returns
the saved answer. If the process/connection fails before answer commit, retry may
call the AI again. Exactly-once external AI invocation is not guaranteed because
the tutor API does not expose idempotency.

Dispatches (including retries) are limited to 10 per student per minute, shared
across conversations and backend instances. Completed replays do not count.

## Errors

Chat errors use `{error: string, code: string}`. Shared authentication failures
may return `{error: string}`. Honor `Retry-After` where provided.

| HTTP | Code | Action |
| --- | --- | --- |
| 400 | `INVALID_ID`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_PAGE`, `INVALID_REQUEST` | Correct request/identifier |
| 401 / 403 | Shared authentication response | Refresh login or show role restriction |
| 404 | `LAB_NOT_FOUND`, `CONVERSATION_NOT_FOUND`, `ATTEMPT_NOT_FOUND` | Check current access and selected context |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Recover the original action; use a new key for changed input |
| 409 | `TURN_PROCESSING`, `TURN_LEASE_LOST` | Retry the same pending action after backoff |
| 413 / 415 / 422 | `INVALID_REQUEST` | Correct source/message/body size or format |
| 413 | `TUTOR_CONTEXT_TOO_LARGE` | Keep the failed action; start a new conversation with less history |
| 429 | `CHAT_RATE_LIMIT`, `CONVERSATION_RATE_LIMIT`, `TUTOR_BUSY` | Wait before retrying |
| 502 | `TUTOR_REQUEST_FAILED`, `TUTOR_INVALID_RESPONSE` | Preserve pending action; service/integration failure |
| 503 | `TUTOR_NOT_CONFIGURED`, `TUTOR_UNAVAILABLE` | Service setup/availability issue |
| 504 | `TUTOR_TIMEOUT` | Retry the same pending action |
| 500 | `CHAT_STORAGE_FAILED` | Delivery may be uncertain; retry the original action |

The tutor's upstream 400/422 responses indicate an integration/context rejection;
they map to safe 502 responses, not raw student-facing validation payloads.

## Verification

`npm test`, `npm run lint`, and `npx tsc --noEmit --incremental false` cover local
validation and adapters. Run `node --env-file=.env.local tests/integration/chat.test.mjs`
for real PostgreSQL migrations, ownership, three-pair history, two students in
parallel, code/result matching, historical feedback, pagination, rate limits,
lease recovery, storage failure, and lost commit acknowledgement. It creates and
removes an isolated schema and mocks authentication and the AI HTTP service.
A deployed tutor and runner must also be smoke-tested before enabling the UI.
