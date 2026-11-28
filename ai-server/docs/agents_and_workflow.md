# Seekhein --- Backend Integration, Agents & End-to-End Workflow

**Audience:** Backend and frontend developers\
**Service:** Socratic AI Programming Lab Assistant\
**API framework:** FastAPI\
**Current endpoint:** `POST /api/v1/tutor`

This guide explains the API contract, the responsibilities of the
agent-side modules, the RAG pipeline, the Code Runner handoff, and the
complete student-to-tutor workflow.

> **Architecture clarification:** Seekhein currently has one LLM-powered
> Socratic tutor agent (`SocraticEngine`). The other files under
> `agent/` are supporting components/modules, not separate autonomous
> LLM agents. They prepare, sanitize, retrieve, and manage context for
> the Socratic tutor.

------------------------------------------------------------------------

# 1. High-level architecture

``` text
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
                            | POST /api/v1/tutor
                            v
                   Seekhein FastAPI API
                            |
                     Request validation
                            |
                            v
                     Context Builder
                     agent/context_builder.py
                            |
             +--------------+----------------+
             |                               |
             v                               v
       RAG Integration                Execution Sanitizer
       agent/rag_integration.py       agent/execution_sanitizer.py
             |                               |
             v                               |
       RAG Retriever                         |
       rag/retriever.py                      |
             |                               |
             v                               |
       ChromaDB + Embeddings                 |
             |                               |
             +---------------+---------------+
                             |
                             v
                    Tutor context assembled
                             |
                             v
                    Socratic Engine
                    agent/socratic_engine.py
                             |
                             v
                    Tutor response + sources
                             |
                             v
                    FastAPI JSON response
                             |
                             v
                    Backend / Frontend
                             |
                             v
                           STUDENT
```

The Code Runner is a separate service. It executes student code and
returns feedback; Seekhein does not replace the runner.

------------------------------------------------------------------------

# 2. Components and responsibilities

## 2.1 API layer --- `api/`

### `api/main.py`

Application entry point. It creates/configures the FastAPI application
and exposes the health-check endpoint. Run the application through
Uvicorn using the command in Section 3.

### `api/routes.py`

Defines the tutor API route and coordinates the request-processing flow:
receive the validated request, build the tutor context, call the
Socratic Engine, and return the response.

### `api/schemas.py`

Defines and validates the request/response data structures using
Pydantic. The request includes the conversation identifier, latest
message, recent history, code fields, and runner feedback.

## 2.2 Agent support modules --- `agent/`

  ---------------------------------------------------------------------------------
  Module                     Responsibility                 In the current tutor
                                                            request path?
  -------------------------- ------------------------------ -----------------------
  `context_builder.py`       Determines the scenario,       Yes
                             retrieves relevant learning
                             context, sanitizes execution
                             feedback, and assembles the
                             context passed to the LLM.

  `execution_sanitizer.py`   Filters runner diagnostics so  Yes
                             hidden test inputs, expected
                             values, actual values, and
                             other restricted test details
                             are not exposed to the tutor
                             prompt.

  `rag_integration.py`       Connects the agent context     Yes
                             builder to the RAG retrieval
                             layer and returns relevant
                             context and source metadata.

  `socratic_engine.py`       Calls the configured LLM       Yes
                             through the OpenAI-compatible
                             OpenRouter client and
                             generates the Socratic tutor
                             response.

  `session_manager.py`       Provides                       Not required for the
                             session/conversation-related   current request flow
                             helper functionality. The
                             current API contract does not
                             use `conversation_id` to load
                             server-side history; the
                             backend sends
                             `recent_messages` on every
                             request.
  ---------------------------------------------------------------------------------

### Important distinction about conversation state

The current API is designed around a stateless request contract:

-   The backend owns the conversation history.
-   The backend sends recent turns in `recent_messages` with every tutor
    request.
-   `conversation_id` is accepted and echoed back, but it is not used by
    the current API to retrieve conversation history.
-   Do not assume the API persists or reconstructs a conversation from
    `conversation_id`.

## 2.3 RAG modules --- `rag/`

The RAG pipeline prepares and searches the lab learning material.

  -----------------------------------------------------------------------
  Module                              Responsibility
  ----------------------------------- -----------------------------------
  `document_processor.py`             Loads and extracts content from
                                      supported source documents.

  `chunker.py`                        Splits extracted lab content into
                                      retrieval-sized chunks while
                                      preserving useful structure and
                                      metadata. It also supports the
                                      structured lab JSON ingestion path.

  `embedding.py`                      Converts text chunks and search
                                      queries into vector embeddings.

  `vector_store.py`                   Stores and queries embeddings in
                                      ChromaDB.

  `ingest.py`                         Coordinates document/JSON ingestion
                                      and writes processed chunks to the
                                      vector store.

  `retriever.py`                      Retrieves relevant chunks for a
                                      student's question, including
                                      supported metadata filtering.
  -----------------------------------------------------------------------

### When does RAG ingestion happen?

Ingestion is a preparation/indexing operation, not something the backend
should perform for every student message.

Typical preparation flow:

``` text
Lab source material
       |
       v
Document processor / JSON loader
       |
       v
Chunker
       |
       v
Embedding model
       |
       v
ChromaDB vector collection
       |
       v
Ready for retrieval during tutor requests
```

During a tutor request, the agent queries the existing vector collection
to retrieve relevant learning material.

------------------------------------------------------------------------

# 3. Run Seekhein locally

From the repository root:

``` powershell
uv run uvicorn api.main:app --reload
```

Local base URL:

``` text
http://127.0.0.1:8000
```

Endpoints:

  Purpose                Method   Path
  ---------------------- -------- -----------------
  Health check           `GET`    `/health`
  Socratic tutor         `POST`   `/api/v1/tutor`
  Interactive API docs   `GET`    `/docs`

The local URL is for development on the same machine. A separately
hosted backend must use the reachable deployed API URL configured for
its environment, not `127.0.0.1`.

### Health check

``` http
GET /health
```

Expected response:

``` json
{
  "status": "ok",
  "message": "Seekhein API is running"
}
```

------------------------------------------------------------------------

# 4. Tutor API contract

## Endpoint

``` http
POST /api/v1/tutor
Content-Type: application/json
```

The backend calls this endpoint for each new student turn.

## Request fields

  ---------------------------------------------------------------------------------
  Field                   Type                          Required Meaning
  ----------------------- ---------------- --------------------- ------------------
  `conversation_id`       string                             Yes Backend
                                                                 conversation
                                                                 identifier, 1--128
                                                                 non-whitespace
                                                                 characters. Echoed
                                                                 in response.

  `message`               string                             Yes Latest student
                                                                 message; cannot be
                                                                 empty or
                                                                 whitespace-only.

  `recent_messages`       array                               No Recent
                                                                 conversation
                                                                 turns; defaults to
                                                                 an empty array.

  `current_code`          string or `null`                   Yes Current editor
                                                                 contents. Send
                                                                 `null` if
                                                                 unavailable.

  `executed_code`         string or `null`                   Yes Exact code used in
                                                                 the latest run.
                                                                 Send `null` if no
                                                                 run is available.

  `output_error`          object or `null`                   Yes Runtime/output
                                                                 error object, if
                                                                 available.
                                                                 Otherwise `null`.

  `validation_feedback`   object or `null`                   Yes Complete Code
                                                                 Runner
                                                                 `view=tutor`
                                                                 response, if
                                                                 available.
                                                                 Otherwise `null`.
  ---------------------------------------------------------------------------------

Include all seven top-level keys. Use JSON `null` for unavailable
nullable values; do not omit them.

## Recent message structure

Each item must use one of the two allowed roles:

``` json
{
  "role": "user",
  "content": "Earlier student message"
}
```

``` json
{
  "role": "assistant",
  "content": "Earlier tutor response"
}
```

Send turns oldest first. The current student message belongs in the
top-level `message` field and should not be duplicated as the final
history item.

## Example: student asks a question without running code

``` json
{
  "conversation_id": "conv-123",
  "message": "Why does my loop only print the first number?",
  "recent_messages": [
    {
      "role": "user",
      "content": "I am trying to print all values in a list."
    },
    {
      "role": "assistant",
      "content": "What part of your code controls which list element is printed?"
    }
  ],
  "current_code": "def print_numbers(nums):\n    for i in range(len(nums)):\n        return nums[i]",
  "executed_code": null,
  "output_error": null,
  "validation_feedback": null
}
```

## Example: student asks about a failed submission

The backend should pass the complete JSON object returned by the Code
Runner's `POST /run?view=tutor` response as `validation_feedback`.

``` json
{
  "conversation_id": "conv-123",
  "message": "Why did my submission fail?",
  "recent_messages": [],
  "current_code": "def maximum(nums):\n    return nums[0]",
  "executed_code": "def maximum(nums):\n    return nums[0]",
  "output_error": null,
  "validation_feedback": {
    "status": "ok",
    "score": 2,
    "ran": 1,
    "passed": 2,
    "failed": 1,
    "total": 3,
    "duration_ms": 12,
    "passed_tests": [],
    "failures": []
  }
}
```

The runner object above is only a shortened illustrative example. In
real integration, pass the entire tutor-view response with all fields
returned by the runner. Do not filter it on the backend. The Seekhein
sanitizer is responsible for filtering it before LLM use.

If the runner supplies a separate output/runtime error object, send it
in `output_error`. Otherwise use `null`.

------------------------------------------------------------------------

# 5. Complete end-to-end student workflow

## Flow A --- Student asks a conceptual or coding question

1.  Student opens the lab and sends a message.
2.  Frontend sends the latest message and current editor contents to the
    backend.
3.  Backend includes:
    -   `conversation_id`
    -   `message`
    -   `recent_messages`
    -   `current_code`
    -   `executed_code: null` if there has been no run
    -   `output_error: null` if there is no runtime error
    -   `validation_feedback: null` if there is no runner feedback
4.  Backend calls `POST /api/v1/tutor`.
5.  FastAPI validates the request.
6.  Context Builder determines the scenario (`coding` when both feedback
    fields are null).
7.  RAG Integration retrieves relevant lab material from ChromaDB.
8.  Execution Sanitizer processes the feedback fields; with both values
    null, there is no runner diagnostic content to expose.
9.  Context Builder assembles the student message, code, scenario,
    retrieved context, and safe execution feedback.
10. Socratic Engine calls the configured LLM and generates a guided
    response.
11. API returns `answer` and `sources`.
12. Backend displays the answer and appends the turn to its conversation
    history.

## Flow B --- Student runs code and receives a runtime error

1.  Student submits code from the lab interface.
2.  Backend sends the code to the Code Runner.
3.  Runner executes it and returns its execution result.
4.  Backend retains the relevant runner response and the exact executed
    code.
5.  Student asks why the code failed, or the product triggers a tutor
    request.
6.  Backend calls `POST /api/v1/tutor` with:
    -   current editor contents in `current_code`
    -   exact submitted code in `executed_code`
    -   runtime/output error in `output_error` when available
    -   complete tutor-view runner response in `validation_feedback`
        when available
    -   recent conversation turns in `recent_messages`
7.  Context Builder detects the scenario from the feedback fields.
8.  Execution Sanitizer removes restricted details from the runner
    diagnostics before they are used in the prompt.
9.  RAG Integration retrieves relevant lab concepts.
10. Socratic Engine explains the error and guides the student with a
    focused question or hint.
11. API returns the tutor answer and sources.
12. Backend displays the response and stores the new turn in its own
    conversation history.

## Flow C --- Student submission runs but some tests fail

1.  Backend sends the student's submitted code to the Code Runner.
2.  Runner executes tests and returns the `view=tutor` response.
3.  Backend sends the complete runner response as `validation_feedback`.
4.  `output_error` is `null` if there is no separate runtime/output
    error.
5.  Context Builder identifies a submission-feedback scenario when the
    runner status is a normal completed status (for example, `ok`).
6.  Execution Sanitizer removes hidden test inputs, expected values,
    actual values, passed-test names, and other restricted details
    according to its allowlist and filtering rules.
7.  RAG retrieves relevant material from the lab.
8.  Socratic Engine receives the safe diagnostics and learning context.
9.  Tutor helps the student reason about the failing behavior without
    simply revealing hidden test answers.
10. API returns the answer and sources to the backend.

## Flow D --- Syntax error or execution timeout

1.  Backend runs the submitted code through the Code Runner.
2.  Runner returns a tutor-view response with a status such as
    `syntax_error`, `runtime_error`, or `timeout`.
3.  Backend sends the complete runner response as `validation_feedback`.
4.  Context Builder maps recognized execution-error statuses to the
    internal `runtime_error` scenario.
5.  Sanitizer filters the diagnostics.
6.  RAG retrieves relevant concepts.
7.  Socratic Engine explains the type of issue and gives a small next
    step for the student to investigate.
8.  API returns the response.

------------------------------------------------------------------------

# 6. Scenario selection performed inside Seekhein

The backend must not send a `scenario` field. The current context
builder derives it.

  -----------------------------------------------------------------------
  Input condition                     Internal scenario
  ----------------------------------- -----------------------------------
  Both `output_error` and             `combined_feedback`
  `validation_feedback` are non-null

  Only `output_error` is non-null     `runtime_error`

  `validation_feedback.status` is     `runtime_error`
  `syntax_error`, `runtime_error`,
  `timeout`, `oom`, or
  `internal_error`

  Other non-null                      `submission_feedback`
  `validation_feedback`

  Both feedback fields are null       `coding`
  -----------------------------------------------------------------------

The backend should send the actual feedback objects and let Seekhein
classify the scenario.

------------------------------------------------------------------------

# 7. Runner integration and data safety

## Required runner view

Use:

``` http
POST /run?view=tutor
```

The `tutor` view is intended to provide diagnostics for the AI tutor. It
can include aggregate execution information and failure/error details.

## What the backend should do

-   Pass the complete `view=tutor` JSON response as
    `validation_feedback`.
-   Do not extract only selected fields.
-   Do not rename the runner's fields.
-   Do not construct a custom scenario.
-   Send `null` when no runner feedback exists.
-   Send the exact executed code separately as `executed_code`.

## What Seekhein does

The `execution_sanitizer.py` module filters runner data before it enters
the LLM context. Its protections include removing hidden test inputs and
expected/actual values, excluding passed-test details, limiting
diagnostic text and traceback size, and retaining selected
aggregate/error information useful for tutoring.

The sanitizer is a prompt-data safety layer. The backend should still
protect its own runner credentials, student data, and service
boundaries.

------------------------------------------------------------------------

# 8. Response format

Successful response shape:

``` json
{
  "status": "success",
  "conversation_id": "conv-123",
  "answer": "Let's inspect the return statement. What happens when Python reaches it during the first loop iteration?",
  "sources": []
}
```

  -----------------------------------------------------------------------
  Field                   Type                    Meaning
  ----------------------- ----------------------- -----------------------
  `status`                string                  `"success"` when
                                                  processing succeeds.

  `conversation_id`       string                  The identifier supplied
                                                  by the backend.

  `answer`                string                  Tutor response to
                                                  display to the student.

  `sources`               array                   Retrieved source
                                                  metadata associated
                                                  with the answer.
  -----------------------------------------------------------------------

Display `answer` in the chat interface. The frontend may use `sources`
to display references to learning material.

------------------------------------------------------------------------

# 9. Error handling

The backend should handle non-success HTTP responses.

  --------------------------------------------------------------------------
  HTTP status             Meaning                 Suggested handling
  ----------------------- ----------------------- --------------------------
  `400`                   Request/context         Read `detail`; correct
                          validation error.       invalid input or display a
                                                  safe message.

  `422`                   FastAPI/Pydantic        Check missing keys,
                          request-schema          incorrect types, and
                          validation failed.      recent-message structure.

  `500`                   Unexpected server-side  Log status and
                          failure.                correlation/conversation
                                                  identifier; show a generic
                                                  retry/error message to the
                                                  student.
  --------------------------------------------------------------------------

Do not expose internal exception details to students.

------------------------------------------------------------------------

# 10. Backend integration checklist

### Service connection

-   [ ] Configure the correct Seekhein API base URL for the environment.
-   [ ] Confirm `GET /health` succeeds.
-   [ ] Send `POST /api/v1/tutor` with JSON content type.
-   [ ] Do not use `127.0.0.1` from a separately hosted service.

### Request construction

-   [ ] Include `conversation_id` and latest `message`.
-   [ ] Send `recent_messages` oldest first.
-   [ ] Use only `user` and `assistant` roles in recent history.
-   [ ] Send `current_code`.
-   [ ] Send `executed_code` or `null`.
-   [ ] Include `output_error` even when null.
-   [ ] Include `validation_feedback` even when null.
-   [ ] Do not send a `scenario` field.

### Runner connection

-   [ ] Run code through the Code Runner service.
-   [ ] Request `view=tutor`.
-   [ ] Pass the full tutor-view response as `validation_feedback`.
-   [ ] Do not filter runner fields on the backend.
-   [ ] Keep the exact executed code in `executed_code`.

### Conversation handling

-   [ ] Backend owns and maintains conversation history.
-   [ ] Send recent turns with each tutor request.
-   [ ] Append the returned tutor answer to the history.
-   [ ] Do not expect Seekhein to load history using `conversation_id`.

### Response and errors

-   [ ] Display `answer`.
-   [ ] Handle `sources` if the UI supports references.
-   [ ] Handle `400`, `422`, and `500` responses.
-   [ ] Avoid exposing internal errors or hidden test details to
    students.

### End-to-end verification

-   [ ] Test a conceptual question without code execution.
-   [ ] Test a question with current editor code.
-   [ ] Test a runtime error.
-   [ ] Test a completed submission with failed tests.
-   [ ] Test a syntax error.
-   [ ] Test a timeout response.
-   [ ] Verify recent conversation turns are included.
-   [ ] Verify hidden test inputs/expected/actual values do not appear
    in the tutor response.
-   [ ] Verify the response reaches the student interface.

------------------------------------------------------------------------

# 11. Current implementation boundaries

The following points are important when planning integration:

1.  **One LLM tutor agent:** `SocraticEngine` is the LLM-powered agent.
    Context Builder, Sanitizer, RAG Integration, and Session Manager are
    supporting modules, not separate LLM agents.
2.  **Backend-owned conversation history:** `conversation_id` is echoed
    but is not a server-side history lookup key in the current API flow.
3.  **No scenario input:** Scenario selection happens in
    `context_builder.py`.
4.  **Runner is separate:** The backend coordinates code execution and
    sends runner feedback to Seekhein.
5.  **RAG is pre-indexed:** Lab materials should be ingested into
    ChromaDB before normal tutoring requests; retrieval happens during
    each relevant request.
6.  **Sanitization happens in Seekhein:** Backend sends the full
    tutor-view object and Seekhein filters it before LLM use.
7.  **Deployment is environment-specific:** The backend must be
    configured with the reachable API URL. Local development URLs are
    not production service URLs.

For the exact request schema and live response schema, use the FastAPI
Swagger page at `/docs` for the deployed version being integrated.
