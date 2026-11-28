# Student lab assistant: stateful tutor integration

The backend owns student access, saved browser-visible messages, execution
selection, and recovery. The AI server owns model history in SQLite and pins lab
context to each session. The backend no longer queries or sends `recent_messages`.

**Keep the original three-exchange window by setting `MAX_HISTORY_TURNS=3` on the
AI server.** Its documented default is 6 exchanges / 12 messages. This cannot be
changed by a backend request field; it is an AI deployment setting.

## Environment and deployment

In backend `.env.local` (ignored by Git), configure:

```dotenv
TUTOR_API_URL=https://tutor.52-64-178-42.sslip.io
TUTOR_API_TOKEN=<actual deployed token>
```

Set these same server-only variables in the backend hosting environment. Never
use `NEXT_PUBLIC_` or send the token to the browser. Caddy requires Bearer
authentication on the deployed tutor except `/health`. Local FastAPI development
may omit the token. The backend accepts either configuration; deployed 401/403
responses become safe `503 TUTOR_AUTH_FAILED` errors.

Deploy the updated AI service before enabling this backend. It must support
persistent sessions, completed-turn idempotency, and session deletion. SQLite
must use persistent storage. Backend PostgreSQL history is not imported into the
AI database, and cannot silently restore a lost AI session database.

Apply migrations in order:

1. `20261128_003_ai_chat.sql` after Submit anyway: server-only `tutor_output`,
   conversations, turns, messages, and a dispatch rate ledger.
2. `20261128_004_stateful_tutor.sql`: protocol versions, acknowledged lab-context
   hashes, recovery state, and coordinated cleanup.

Stop/drain old backend workers before applying the second migration. It rejects
existing processing turns; finish/recover them with the old backend first. All
existing conversations receive `protocol_version: 1` and remain readable. New
conversations use version 2. Never replay old questions to populate AI history.
Existing executions and submission outcomes are not modified by this migration.

The runner must support `/run?view=both`, already available in this repository.
It executes code once, providing student output for the browser and complete
tutor feedback for server-side storage. Historical runs retain null tutor output.

AI calls have a 45-second deadline; routes declare a 60-second hosting budget.
Processing/cleanup leases last 120 seconds. Calls to the AI run outside database
transactions. Configure hosting to allow these request durations.

## What changes in the frontend

The existing send-message body, Bearer auth, browser idempotency header, and
successful reply shape are unchanged. Add these behaviors:

- Use `can_send` and `blocking_turn_id` from message history to disable sending
  while a turn is processing or needs recovery.
- Show **Recover previous answer** for `recovery_required` turns, and call the
  recovery endpoint. It uses the backend snapshot, even if browser storage was
  lost or the editor has changed.
- Keep version 1 chats readable, but start a new conversation to continue them.
- Wire Delete/Reset through the backend cleanup endpoint. An unresolved turn
  must be recovered first. Reset means delete successfully, then create a new
  conversation UUID through the existing create endpoint; never reuse an ID.
- If cleanup fails, keep a retry-delete action. Do not resume messaging in a
  conversation whose lifecycle is `deleting`.

No frontend code should send lab context, hidden tests, reference solutions,
history, tutor feedback, AI credentials, or upstream idempotency keys.

## Routes and access

Every route requires `Authorization: Bearer <Supabase access token>`, student
role, conversation ownership, and current course enrollment. Authenticated
responses use `Cache-Control: private, no-store`.

| Route | Success |
| --- | --- |
| `POST /api/labs/{labId}/conversations` (no body) | `201 Conversation` |
| `GET /api/labs/{labId}/conversations?after=0&limit=20` | `200 {conversations: Conversation[], next_after: number \| null}` |
| `POST /api/conversations/{conversationId}/messages` | `200 ChatReply` |
| `GET /api/conversations/{conversationId}/messages?after=0&limit=20` | `200 ChatHistory` |
| `POST /api/conversations/{conversationId}/turns/{turnId}/recover` (no body/key required) | `200 ChatReply` |
| `DELETE /api/conversations/{conversationId}` (no body) | `200 {conversation_id: string, deleted: true}` |

Conversation listing is newest-created first; `after` is a numeric offset.
History is paginated by whole turns, oldest first; `after` is a turn sequence.
Use `next_after` for the next page. Limits are 1–50 (default 20).
`can_send` and `blocking_turn_id` describe the conversation, not just the page.
They are advisory snapshots; a concurrent request can still receive 409.

Conversation creation is not idempotent. If its response is lost, list existing
conversations before creating another. Creation is limited to 20 per student per
hour. Deleted tombstones continue to count against that creation rate.

```ts
type Conversation = {
  conversation_id: string
  lab_id: string
  created_at: string
  updated_at: string
  protocol_version: 1 | 2
  lifecycle: "active" | "deleting" // deleted conversations are omitted from lists
}
type ChatInput = {
  message: string             // non-whitespace, <= 8 KiB UTF-8
  current_code: string | null // required key; <= 64 KiB; empty string allowed
  attempt_id?: string | null  // saved execution UUID; null/omitted means latest saved
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
  protocol_version: 1 | 2
  can_send: boolean
  blocking_turn_id: string | null
  turns: Array<{
    turn_id: string
    sequence: number
    idempotency_key: string
    attempt_id: string | null
    status: "processing" | "completed" | "failed" | "recovery_required"
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

## Sending and recovering a question

```http
POST /api/conversations/{conversationId}/messages
Authorization: Bearer <student-token>
Content-Type: application/json
Idempotency-Key: <new browser action UUID>

{"message":"Why does my loop stop?","current_code":"def f(xs):\n    for x in xs:\n        return x\n","attempt_id":null}
```

Only these three JSON fields are accepted. The body limit is 512 KiB. Invalid
Unicode and NUL characters in message/code are rejected.

Persist the browser key and exact input before sending, under a key scoped to
student, conversation, and action UUID. Retry unchanged input with the same key.
Different input under an existing key returns `409 IDEMPOTENCY_KEY_REUSED`.
Omitted and null attempt IDs are equivalent. New questions use new browser keys.

Each backend turn has a UUID distinct from the browser key. This persisted
`turn_id` is sent to the AI as **`Idempotency-Key`** on every attempt, including
lease recovery. No body `idempotency_key` is sent, avoiding header/body conflicts.

A completed backend replay returns the saved answer without calling the AI.
When AI success was saved remotely but lost locally, retry/recover uses the same
upstream turn key, allowing the AI to return its saved answer without appending
another completed exchange. Success is returned to the browser only after local
answer persistence commits.

If pending browser storage is lost, retrieve history and call:

```http
POST /api/conversations/{conversationId}/turns/{turnId}/recover
Authorization: Bearer <student-token>
```

Recovery accepts no replacement message/code. It uses the exact saved request.
For a completed turn it returns the original reply. For an active lease it
returns `409 TURN_PROCESSING`. Expired leases and uncertain responses require
recovery of that same turn before a new question or deletion is allowed.

Known AI 400/401/403/422/429/503/500 failures have no saved AI turn under the API
contract; they produce a retryable/failed local turn. A new question is allowed
after a definite failure. Once a newer turn has been dispatched, an older failed
turn cannot be retried in place (`TURN_SUPERSEDED`): send it as a new question so
AI history and local ordering stay consistent.

Timeouts, transport loss, malformed success, and failed local persistence after an
AI answer produce `recovery_required`. A failed recovery attempt does not clear
an earlier uncertain outcome. One active/unresolved turn blocks only its own
conversation; different students can converse concurrently.

Completed-turn replay is guaranteed by the supplied AI contract. Its documentation
does not promise deduplication of simultaneous still-running OpenRouter calls.
The AI service must also serialize in-flight requests per session/key if it needs
exactly-once model invocation during overlapping retries; backend lease fencing
prevents stale workers from overwriting local answers.

## Lab and execution context

For each new turn the backend reads `title`, `instructions`, `starter`, `tests`,
and `solution` from the authorized lab. It hashes those values. It sends the full
`lab_context` on the first request or when that hash differs from the last
successfully acknowledged context. Unchanged follow-ups omit it.

The outgoing payload and lab hash are frozen on the turn. Retry never replaces
that payload with newer teacher edits. When a context update is dispatched, the
backend invalidates its acknowledgement until success: the AI can pin context
even before a model call fails. A later new question therefore resends context
when acknowledgement is uncertain. A successful answer and context acknowledgement
commit in the same local transaction.

Student Run returns its saved `attempt_id`; teacher previews return null.
Accepted final `submission_id` values also select execution context. Ordinary
rejected Submit requests do not create execution records; use Run to obtain a
saved attempt when asking about such code.

Explicit attempt IDs must belong to the same student and lab. Null/omitted selects
the latest saved execution by server timestamp. The backend freezes that choice,
its exact code, and full tutor feedback for retry. Current editor code stays
separate and may differ from executed code. Missing execution data is null;
historical executions without tutor output send `validation_feedback: null`.

Example backend-to-AI request:

```http
POST /api/v1/tutor
Authorization: Bearer <TUTOR_API_TOKEN>
Idempotency-Key: <persisted backend turn UUID>
Content-Type: application/json
```

```json
{
  "conversation_id": "backend-conversation-uuid",
  "message": "The new student question",
  "lab_context": {
    "title": "Lab title",
    "instructions": "Problem statement",
    "starter": "Starter code",
    "tests": "Private test source",
    "solution": "Private reference solution"
  },
  "current_code": null,
  "executed_code": null,
  "output_error": null,
  "validation_feedback": null
}
```

The runner has no separate output-error object; errors stay in the complete
`validation_feedback`. No scenario or recent_messages field is sent.

Raw lab references, context snapshots, and tutor diagnostics are not exposed by
frontend chat/history/teacher-report routes or logs. They are sent to the trusted
AI service per its contract. That service is responsible for sanitizing context
and generating Socratic answers without exposing private reference material; the
backend does not claim model-level confidentiality solely from field labels.

Replies must contain `status: "success"`, the same conversation ID, a nonempty
answer up to 32 KiB, and a sources array. The full response is capped at 256 KiB.
Render answer/source text safely; sources have no fixed metadata schema.

## Deletion and reset

DELETE requires the same ownership/enrollment checks as chat. An unresolved turn
returns `409 TURN_RECOVERY_REQUIRED`; recover it before deleting. Once no turn is
outstanding, the backend commits lifecycle `deleting`, preventing further sends,
and calls the authenticated AI session DELETE outside a database transaction.

Both upstream `deleted: true` and `deleted: false` mean cleanup succeeded. Only
then does the backend delete local messages and private turn snapshots. A minimal
conversation tombstone remains for safe deletion replay. Dispatch timestamps
remain for rate enforcement with their deleted turn IDs cleared. Existing lab
runs and final submissions are not deleted.

If remote cleanup or local persistence fails, lifecycle remains `deleting` and
DELETE can be retried. Cleanup has a lease so concurrent callers do not race.
Repeated DELETE after completion returns the same successful result without a new
AI call. Lists omit deleted chats; their history endpoint returns 404.

Reset uses successful DELETE followed by conversation creation with a fresh UUID.
Never reuse old conversation or turn IDs. The AI service should serialize session
deletion with its own in-flight processing; the backend refuses deletion while
it knows of an unresolved request and never reuses a deleted session ID.

## Errors

Chat errors use `{error: string, code: string}`; shared authentication errors may
return `{error: string}`. Honor `Retry-After` where present.

| HTTP | Code | Frontend handling |
| --- | --- | --- |
| 400 | `INVALID_ID`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_PAGE`, `INVALID_REQUEST` | Correct request |
| 401 / 403 | Shared authentication response | Refresh login/show role restriction |
| 404 | `LAB_NOT_FOUND`, `CONVERSATION_NOT_FOUND`, `ATTEMPT_NOT_FOUND`, `TURN_NOT_FOUND` | Check access and selected resource |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Recover original input or use a new key for a new question |
| 409 | `TURN_PROCESSING`, `TURN_LEASE_LOST` | Retry/recover same turn after backoff |
| 409 | `TURN_RECOVERY_REQUIRED` | Load history and recover `blocking_turn_id` |
| 409 | `TURN_SUPERSEDED` | Send the question as a new turn |
| 409 | `CONVERSATION_LEGACY` | Keep old history readable; create a new chat |
| 409 | `CONVERSATION_DELETING`, `CLEANUP_PROCESSING` | Retry DELETE; do not send messages |
| 413 / 415 / 422 | `INVALID_REQUEST` | Correct source/message/body format or size |
| 413 | `TUTOR_CONTEXT_TOO_LARGE` | Context exceeds the integration limit; operator review needed |
| 429 | `CHAT_RATE_LIMIT`, `CONVERSATION_RATE_LIMIT`, `TUTOR_BUSY` | Wait before retrying |
| 502 | `TUTOR_REQUEST_FAILED`, `TUTOR_INVALID_RESPONSE` | Check turn history; recover uncertain outcomes |
| 503 | `TUTOR_AUTH_FAILED` | Configure the backend's actual deployed token |
| 503 | `TUTOR_NOT_CONFIGURED`, `TUTOR_UNAVAILABLE` | Configuration/service issue; retain pending action |
| 504 | `TUTOR_TIMEOUT` | Recover the original turn |
| 500 | `CHAT_STORAGE_FAILED` | Delivery uncertain; recover original turn or retry DELETE |

AI 400/422 map to safe 502 errors without forwarding validation internals. Logs
contain conversation/turn IDs, safe codes, and upstream status, not credentials,
student code, message bodies, or private context.

Dispatches, including recoveries, are limited to 10 per student per minute across
conversations/workers. Completed backend replays do not count.

## Verification

Run `npm test`, `npm run lint`, and `npx tsc --noEmit --incremental false`.
`node --env-file=.env.local tests/integration/chat.test.mjs` uses real PostgreSQL
in an isolated schema and a simulated stateful AI service to test ownership,
context updates, stable upstream keys, lost responses, save failures, concurrent
students, uncertain recovery, legacy chats, and coordinated cleanup.
The live AI smoke test uses synthetic context, a fresh UUID, replay verification,
and session cleanup; never use a real student's session for integration testing.
