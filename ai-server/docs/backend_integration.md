# Seekhein Socratic Lab Assistant — Backend Integration Guide

**Primary endpoint:** `POST /api/v1/tutor`  
**Session cleanup:** `DELETE /api/v1/sessions/{conversation_id}`  
**Health check:** `GET /health`  
**Request format:** JSON  
**Implementation:** FastAPI (`ai-server/api/main.py`)

This document is the API contract between the Seekhein backend and the `ai-server` Socratic Lab Assistant.

---

## 1. Endpoints & Authentication

| Method | Path | Purpose | Auth (when deployed behind Caddy) |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Health check | Public (no token required) |
| `GET` | `/docs` | Interactive Swagger UI | `Authorization: Bearer <TUTOR_API_TOKEN>` |
| `POST` | `/api/v1/tutor` | Send a student turn and receive Socratic guidance | `Authorization: Bearer <TUTOR_API_TOKEN>` |
| `DELETE` | `/api/v1/sessions/{conversation_id}` | Delete a stored session, its history, and its pinned `lab_context` | `Authorization: Bearer <TUTOR_API_TOKEN>` |

> **Note:** `ai-server` itself does not validate bearer tokens; when deployed with `scripts/deploy-ec2.sh`, Caddy enforces `Authorization: Bearer <TUTOR_API_TOKEN>` on every path except `/health`. In local development (`http://127.0.0.1:8000`), no `Authorization` header is needed.

### Local Run & Health Check

From `ai-server/`:

```bash
uv run uvicorn api.main:app --reload
```

```http
GET /health
```

Expected response:

```json
{
  "status": "ok",
  "message": "Seekhein API is running"
}
```

Do not hard-code `127.0.0.1` in a remotely hosted backend; configure `TUTOR_API_URL` (and optional `TUTOR_API_TOKEN`) per environment.

---

## 2. Server-Side State Model

`ai-server` manages conversation context in a local SQLite database (`SESSION_DB_PATH`, defaulting to `./data/sessions.db`, or `/opt/ai-server/data/sessions.db` on EC2):

1. **Pinned `lab_context`:** When the backend sends `lab_context` (typically on turn 1), `ai-server` stores it on the `sessions` row for `conversation_id` and injects it as a dedicated `system` message **before** the conversation history on every turn — so it is never evicted as the chat grows.
2. **Sliding history window:** Every completed turn is persisted in SQLite (`messages` table). On each request, `ai-server` loads the most recent `MAX_HISTORY_TURNS` turns (default `6` turns = `12` messages) in chronological order and sends them to OpenRouter.
3. **Turn-level idempotency:** Completed turns with an `idempotency_key` are recorded in the `turns` table so backend retries safely return the saved response without calling OpenRouter again or duplicating history.

---

## 3. Tutor Endpoint (`POST /api/v1/tutor`)

```http
POST /api/v1/tutor
Content-Type: application/json
Idempotency-Key: <unique-turn-uuid>
Authorization: Bearer <TUTOR_API_TOKEN>
```

### Request Fields

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `conversation_id` | `string` | **Yes** | Conversation identifier (`1–128` non-whitespace chars). Used as the SQLite session key and echoed in the response. |
| `message` | `string` | **Yes** | Student's current message. Must not be empty or whitespace-only. |
| `idempotency_key` | `string \| null` | No | Per-turn deduplication key (`1–128` non-whitespace chars). Also accepted via the `Idempotency-Key` HTTP header (`idempotency_key` in the JSON body takes precedence if both are sent). |
| `lab_context` | `object \| null` | No | Lab metadata pinned to the session (`title`, `instructions`, `starter_code`/`starter`, `tests`, `reference_solution`/`solution`). Send on turn 1 (or when updating), and omit or send `null` on subsequent turns. |
| `current_code` | `string \| null` | No | Complete code currently in the student's editor. |
| `executed_code` | `string \| null` | No | Exact code used in the student's most recent execution. |
| `output_error` | `object \| null` | No | Separate runtime/output error object from the runner, if any. |
| `validation_feedback` | `object \| null` | No | Complete Code Runner `POST /run?view=tutor` JSON payload. Do not pre-filter fields on the backend. |
| `recent_messages` | `array` | Legacy (optional) | Retained only for backwards compatibility during backend migration. `ai-server` **ignores** any supplied `recent_messages` and reads history from SQLite instead. |

### `lab_context` Object Fields

| Field | Accepted Aliases | Description | Visibility to Student |
| :--- | :--- | :--- | :--- |
| `title` | — | Lab title (`string \| null`) | Safe reference |
| `instructions` | — | Lab prompt / problem statement (`string \| null`) | Safe reference |
| `starter_code` | `starter` | Starter code given to students (`string \| null`) | Safe reference |
| `tests` | — | Lab unit test source (`string \| null`) | **Private teacher-only reference** — never revealed to students |
| `reference_solution` | `solution` | Reference solution code (`string \| null`) | **Private teacher-only reference** — never revealed to students |

`starter` and `solution` are accepted as aliases so the backend can pass fields straight from `public.labs`. Empty/whitespace-only string fields inside `lab_context` are ignored.

---

## 4. Idempotency Key (`idempotency_key` / `Idempotency-Key`)

### What it is
An **idempotency key** is a unique string generated per student turn (for example, a UUID v4 or the backend's `turn_id` / client `Idempotency-Key` header) sent on `POST /api/v1/tutor`.

You can send it in either place:
* HTTP header: `Idempotency-Key: <key>`
* JSON body: `"idempotency_key": "<key>"`

If both are provided, the JSON body `idempotency_key` takes precedence. Keys are trimmed and capped at 128 characters.

### Why it is needed
Because `ai-server` now owns the conversation history in SQLite, network timeouts or backend retries (such as your lease-recovery worker retrying an in-flight turn) could otherwise cause the same student message to be processed twice — costing double OpenRouter calls and inserting duplicate user/assistant turns into `ai-server`'s history.

### Lifecycle & Behavior Rules

1. **Saved only after OpenRouter succeeds (`200`):** `ai-server` calls OpenRouter first, and only writes the turn to `messages` and `turns` once a valid response is returned.
2. **Duplicate retry after success -> cached replay:** If the backend retries a request with the same `(conversation_id, idempotency_key)` that already succeeded, `ai-server` immediately returns the saved `answer` and `sources` without calling OpenRouter or appending duplicate rows.
3. **Failure (`400`, `422`, `429`, `503`, `500`) -> nothing saved:** If OpenRouter rate-limits (`429`), times out (`503`), or fails (`500`), neither the messages nor the `idempotency_key` are stored. Retrying with the **same** `idempotency_key` runs the turn cleanly.
4. **New turns require a new key:** Every new student message must use a new `idempotency_key`. Reusing an old key on the same `conversation_id` will return that earlier turn's cached response.
5. **Scoped per conversation:** Uniqueness is `(conversation_id, idempotency_key)`.

---

## 5. Examples

### Turn 1: Initial Student Question (with `lab_context` and `Idempotency-Key`)

```http
POST /api/v1/tutor
Content-Type: application/json
Idempotency-Key: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
Authorization: Bearer <TUTOR_API_TOKEN>
```

```json
{
  "conversation_id": "conv-123",
  "message": "Why does my loop only print the first number?",
  "lab_context": {
    "title": "Print All Elements",
    "instructions": "Write a function that returns a list of all numbers doubled.",
    "starter": "def double_all(nums):\n    pass",
    "tests": "assert double_all([1, 2, 3]) == [2, 4, 6]",
    "solution": "def double_all(nums):\n    return [n * 2 for n in nums]"
  },
  "current_code": "def double_all(nums):\n    for n in nums:\n        return n * 2",
  "executed_code": null,
  "output_error": null,
  "validation_feedback": null
}
```

### Turn 2: Follow-up After Code Runner Execution (`lab_context` & `recent_messages` omitted)

`ai-server` automatically loads Turn 1's messages and the pinned `lab_context` from SQLite:

```http
POST /api/v1/tutor
Content-Type: application/json
Idempotency-Key: 109156be-c4fb-41ea-b1b4-efe1671c5836
Authorization: Bearer <TUTOR_API_TOKEN>
```

```json
{
  "conversation_id": "conv-123",
  "message": "I moved return out of the loop, why did one test still fail?",
  "current_code": "def double_all(nums):\n    out = []\n    for n in nums:\n        out.append(n)\n    return out",
  "executed_code": "def double_all(nums):\n    out = []\n    for n in nums:\n        out.append(n)\n    return out",
  "output_error": null,
  "validation_feedback": {
    "status": "ok",
    "score": 0,
    "ran": 1,
    "passed": 0,
    "failed": 1,
    "total": 1,
    "duration_ms": 12,
    "passed_tests": [],
    "failures": []
  }
}
```

### Successful Response (`200 OK`)

```json
{
  "status": "success",
  "conversation_id": "conv-123",
  "answer": "Look closely at what you append inside the loop. Are you appending the original number or its doubled value?",
  "sources": []
}
```

### Reset / Delete Session (`DELETE /api/v1/sessions/{conversation_id}`)

Call this when a user deletes or resets a conversation so its SQLite history, idempotency keys, and pinned `lab_context` are wiped:

```http
DELETE /api/v1/sessions/conv-123
Authorization: Bearer <TUTOR_API_TOKEN>
```

Response (`200 OK`):

```json
{
  "status": "success",
  "conversation_id": "conv-123",
  "deleted": true
}
```

(`deleted` is `false` if no session existed for that ID; the endpoint is idempotent.)

---

## 6. Internal Scenario Selection

The backend does **not** send a `scenario` field. `agent/context_builder.py` derives it from `output_error` and `validation_feedback`:

| Input condition | Internal scenario |
| :--- | :--- |
| Both `output_error` and `validation_feedback` are non-null | `combined_feedback` |
| Only `output_error` is non-null | `runtime_error` |
| `validation_feedback.status` is `syntax_error`, `runtime_error`, `timeout`, `oom`, or `internal_error` | `runtime_error` |
| Other non-null `validation_feedback` | `submission_feedback` |
| Both feedback fields are `null` | `coding` |

---

## 7. Error Responses

| HTTP status | Meaning | Backend handling |
| :--- | :--- | :--- |
| `400` | Application validation error (e.g., empty message/ID, oversized `Idempotency-Key` header) | Read `detail`; fix request payload/headers. Turn was not saved. |
| `401` | Missing or invalid `Authorization: Bearer <TUTOR_API_TOKEN>` at Caddy edge proxy | Check `TUTOR_API_TOKEN` in backend environment. |
| `422` | FastAPI/Pydantic schema validation failed | Check field types and required keys (`conversation_id`, `message`). Turn was not saved. |
| `429` | OpenRouter upstream rate limit (`RateLimitError` or HTTP 429) | Retryable; turn was **not** saved, so retry with the same `idempotency_key`. |
| `503` | OpenRouter timeout, connection error, or upstream 5xx | Retryable; turn was **not** saved, so retry with the same `idempotency_key`. |
| `500` | Unexpected internal server error | Log status + `conversation_id`; do not expose internal details to the student. Turn was not saved. |

---

## 8. Backend Integration Checklist

- [ ] Set `TUTOR_API_URL` (e.g. `https://tutor.<ip>.sslip.io`) and `TUTOR_API_TOKEN` in backend environment variables.
- [ ] Send `POST /api/v1/tutor` with `Authorization: Bearer <TUTOR_API_TOKEN>` and `Content-Type: application/json`.
- [ ] Send a unique `Idempotency-Key` header (or `idempotency_key` body field) per turn, and reuse the same key on retries.
- [ ] Send `lab_context` (`title`, `instructions`, `starter`, `tests`, `solution`) on turn 1 (or whenever updated); omit or send `null` on follow-up turns.
- [ ] Stop querying/sending `recent_messages` to `ai-server` (or pass `[]` during transition — it is ignored).
- [ ] Send `current_code`, `executed_code`, `output_error`, and the full Code Runner `view=tutor` JSON as `validation_feedback`.
- [ ] Handle `429` and `503` as transient/retryable failures, and `400`/`422`/`500` appropriately.
- [ ] Optionally call `DELETE /api/v1/sessions/{conversation_id}` when deleting or resetting a chat conversation.
