# Seekhein — Backend Integration, Agents & End-to-End Workflow

**Audience:** Backend and frontend developers  
**Service:** Socratic AI Programming Lab Assistant  
**API framework:** FastAPI (`ai-server/api/main.py`)  
**Primary endpoints:** `POST /api/v1/tutor`, `DELETE /api/v1/sessions/{conversation_id}`, `GET /health`

This guide explains the architecture, agent-side modules, SQLite session state, optional RAG pipeline, Code Runner handoff, and end-to-end student-to-tutor workflow.

> **Architecture clarification:** Seekhein has one LLM-powered Socratic tutor agent (`SocraticEngine`). The other modules under `agent/` prepare, sanitize, persist, and retrieve context for the Socratic tutor.

---

## 1. High-Level Architecture

```text
                         STUDENT
                            |
                            v
                   Frontend / Lab UI
                            |
             +--------------+--------------+
             |                             |
             v                             v
       Student message                Code submission
             |                             |
             |                             v
             |                       Backend / Runner
             |                             |
             |                       POST /run?view=tutor
             |                             |
             |                    Tutor-view execution result
             |                             |
             +--------------+--------------+
                            |
                            v
                   Backend application
                            |
                            | POST /api/v1/tutor (+ Idempotency-Key)
                            v
                   Seekhein FastAPI API (api/main.py)
                            |
             +--------------+--------------+
             |                             |
             v                             v
     SQLiteSessionStore            Context Builder
     (agent/session_store.py)      (agent/context_builder.py)
     - Pinned lab_context                  |
     - Last MAX_HISTORY_TURNS      +-------+--------+
     - Idempotency cache           |                |
             |                     v                v
             |             RAG Integration   Execution Sanitizer
             |             (optional,        (agent/execution_sanitizer.py)
             |              ENABLE_RAG)
             |                     |                |
             +---------------------+----------------+
                                   |
                                   v
                            Socratic Engine
                       (agent/socratic_engine.py)
                                   |
                                   v
                        Save turn on 200 success
                        -> Tutor response + sources
                                   |
                                   v
                           Backend / Frontend
                                   |
                                   v
                                 STUDENT
```

The Code Runner is a separate service. It executes student code and returns diagnostics; `ai-server` does not execute student code.

---

## 2. Components and Responsibilities

### 2.1 API Layer — `api/`

* **`api/main.py`**: Active FastAPI entry point exposing `GET /health`, `POST /api/v1/tutor`, and `DELETE /api/v1/sessions/{conversation_id}`, plus OpenRouter error mapping (`429` / `503` / `500`) and logging.
* **`api/schemas.py`**: Pydantic request models (`TutorRequest`, `LabContext`, `ConversationMessage`).
* **`api/routes.py`**: Legacy/unused router kept from an earlier iteration; the live server runs solely from `api/main.py`.

### 2.2 Agent & Session Modules — `agent/`

| Module | Responsibility | In live request path? |
| :--- | :--- | :--- |
| `session_store.py` | SQLite-backed `SQLiteSessionStore` (`SESSION_DB_PATH`, default `./data/sessions.db`). Persists pinned `lab_context`, full message history, sliding-window reads (`MAX_HISTORY_TURNS`, default `6`), and turn idempotency records. | **Yes** |
| `context_builder.py` | Determines the internal scenario, runs optional RAG retrieval, sanitizes execution feedback, and assembles context + pinned `lab_context`. | **Yes** |
| `execution_sanitizer.py` | Filters Code Runner diagnostics so hidden test inputs, expected values, actual values, and passed-test names are stripped before reaching the LLM prompt. | **Yes** |
| `rag_integration.py` | Gates retrieval behind `ENABLE_RAG` (defaults to `false`). When `false`, returns empty context/sources without importing `rag/` or heavy ML libraries. | **Yes** (no-op when disabled) |
| `socratic_engine.py` | Calls the configured OpenRouter model via the OpenAI client, injecting the system prompt, pinned `lab_context` (teacher-only private reference), recent history, and current turn context. | **Yes** |
| `session_manager.py` | Legacy in-memory dictionary helper tested by `tests/test_session_manager.py`. | No (superseded by `session_store.py`) |

### Server-Managed Conversation State

* `ai-server` persists conversation history and pinned `lab_context` in SQLite keyed by `conversation_id`.
* On turn 1 (or any turn where `lab_context` is supplied), `lab_context` is stored on the session row and always injected as a dedicated `system` message **before** chat history, so it is never dropped as older turns leave the `MAX_HISTORY_TURNS` window.
* `lab_context` may include `title`, `instructions`, `starter_code` (alias `starter`), `tests`, and `reference_solution` (alias `solution`). `SocraticEngine` treats `tests` and `reference_solution` as private teacher-only reference and is instructed never to reveal them to students.
* `ai-server` ignores any legacy `recent_messages` field sent by older backend callers.
* Turns are persisted **only after** OpenRouter returns a valid reply; failed/rate-limited/timed-out requests (`400`, `422`, `429`, `503`, `500`) leave SQLite history unchanged.

### 2.3 Optional RAG Modules — `rag/`

Heavy RAG dependencies (`chromadb`, `pymupdf`, `sentence-transformers`) live in `[project.optional-dependencies].rag` in `pyproject.toml`.

* By default, `uv sync` installs only the lightweight runtime dependencies and `ENABLE_RAG` defaults to `false`.
* To enable local RAG: install with `uv sync --extra rag`, ingest lab materials (`rag/ingest.py`) into `./chroma_db`, and set `ENABLE_RAG=true`.

---

## 3. Run Locally

From `ai-server/`:

```bash
uv run uvicorn api.main:app --reload
```

Local base URL: `http://127.0.0.1:8000`

| Purpose | Method | Path |
| :--- | :--- | :--- |
| Health check | `GET` | `/health` |
| Socratic tutor | `POST` | `/api/v1/tutor` |
| Delete session | `DELETE` | `/api/v1/sessions/{conversation_id}` |
| Interactive API docs | `GET` | `/docs` |

---

## 4. Tutor API Contract Summary

See [`docs/backend_integration.md`](backend_integration.md) for the complete request/response specification, `lab_context` schema, `Idempotency-Key` lifecycle, examples, and checklist.

Key points:
* Send `conversation_id` and current `message` (plus `Idempotency-Key` header or `idempotency_key` body field).
* Send `lab_context` on turn 1 (or when updating it); omit or send `null` on follow-up turns.
* Send `current_code`, `executed_code`, `output_error`, and the full Code Runner `view=tutor` response in `validation_feedback` whenever available.
* Omit `recent_messages` (or pass `[]` during migration); `ai-server` manages history itself.

---

## 5. Complete End-to-End Student Workflow

### Flow A — Student Asks a Conceptual or Coding Question

1. Student sends a message from the Lab UI.
2. Backend calls `POST /api/v1/tutor` with `conversation_id`, `Idempotency-Key`, `message`, `lab_context` (if turn 1), `current_code`, and `null` for `executed_code`/`output_error`/`validation_feedback`.
3. `SQLiteSessionStore` creates/loads the session, pins `lab_context` if supplied, checks `(conversation_id, idempotency_key)` for a cached reply, and fetches up to `MAX_HISTORY_TURNS` recent turns.
4. `ContextBuilder` classifies the scenario (`coding`), skips or runs optional RAG, and assembles context.
5. `SocraticEngine` sends `[system_prompt, pinned_lab_context?, ...recent_messages, current_turn_context]` to OpenRouter.
6. On success, `SQLiteSessionStore.save_turn` atomically stores the user + assistant messages and the idempotency record.
7. FastAPI returns `200 OK` with `status`, `conversation_id`, `answer`, and `sources`.

### Flow B — Student Runs Code & Receives a Runtime Error or Failed Tests

1. Backend executes student code via Code Runner (`POST /run?view=tutor`).
2. Student asks about the error/failure (or UI triggers assistance).
3. Backend calls `POST /api/v1/tutor` with `conversation_id`, a new `Idempotency-Key`, `message`, `current_code`, `executed_code`, `output_error` (if any), and the complete Code Runner response in `validation_feedback`.
4. `execution_sanitizer.py` strips hidden test inputs, expected/actual values, and passed-test names before building the prompt.
5. `SocraticEngine` uses the sanitized diagnostics + pinned `lab_context` (including private `tests`/`reference_solution`) + recent history to generate a focused Socratic hint without leaking hidden tests or solutions.
6. On success, the turn is saved in SQLite and returned to the backend.

### Flow C — Network Timeout / Retry or OpenRouter Rate Limit

* **If `ai-server` already completed the turn** before the client timed out, retrying with the **same** `idempotency_key` returns the cached `200 OK` response immediately without re-running the LLM or duplicating messages.
* **If OpenRouter returned `429` or timed out (`503`)**, `ai-server` does **not** write the turn or `idempotency_key` to SQLite, so retrying with the **same** `idempotency_key` executes fresh.

---

## 6. Scenario Selection Inside Seekhein

The backend must not send a `scenario` field; `agent/context_builder.py` derives it:

| Input condition | Internal scenario |
| :--- | :--- |
| Both `output_error` and `validation_feedback` are non-null | `combined_feedback` |
| Only `output_error` is non-null | `runtime_error` |
| `validation_feedback.status` is `syntax_error`, `runtime_error`, `timeout`, `oom`, or `internal_error` | `runtime_error` |
| Other non-null `validation_feedback` | `submission_feedback` |
| Both feedback fields are `null` | `coding` |

---

## 7. Error Handling

| HTTP status | Meaning | Suggested handling |
| :--- | :--- | :--- |
| `400` | Validation error (empty message/ID or invalid `Idempotency-Key` header) | Read `detail` and fix request. |
| `401` | Invalid/missing `Authorization: Bearer <TUTOR_API_TOKEN>` (Caddy gateway) | Verify backend `TUTOR_API_TOKEN`. |
| `422` | FastAPI/Pydantic schema validation failed | Check field names and types. |
| `429` | OpenRouter rate-limited | Transient; retry with the same `idempotency_key`. |
| `503` | OpenRouter timeout, connection failure, or upstream 5xx | Transient; retry with the same `idempotency_key`. |
| `500` | Unexpected server error | Log `conversation_id`; show safe retry message. |

---

## 8. Current Implementation Boundaries

1. **One LLM tutor agent:** `SocraticEngine` is the LLM agent; `session_store.py`, `context_builder.py`, `execution_sanitizer.py`, and `rag_integration.py` are supporting Python modules.
2. **Server-side SQLite persistence:** `ai-server` stores history, pinned `lab_context`, and idempotency keys in a single local SQLite file (`SESSION_DB_PATH`). This is designed for single-instance deployment (such as EC2 with `/opt/ai-server/data` preserved across redeploys).
3. **Optional RAG:** Disabled by default (`ENABLE_RAG=false`) so production deploys stay lightweight (~60 MB RAM) until lab-document indexing is needed.
4. **Runner is separate:** The backend coordinates execution with Code Runner (`view=tutor`) and passes the full result to `ai-server`, where `execution_sanitizer.py` filters it.
