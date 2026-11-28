# Seekhein Socratic Lab Assistant --- Backend Integration Guide

**API:** `POST /api/v1/tutor`\
**Health check:** `GET /health`\
**Request format:** JSON\
**Current implementation:** FastAPI

This document describes how the backend should call the Seekhein
Socratic Lab Assistant API.

------------------------------------------------------------------------

## 1. Run the API locally

From the Seekhein project root:

``` powershell
uv run uvicorn api.main:app --reload
```

The local API base URL is:

``` text
http://127.0.0.1:8000
```

Useful endpoints:

-   Health check: `GET http://127.0.0.1:8000/health`
-   Interactive API documentation: `http://127.0.0.1:8000/docs`
-   Tutor endpoint: `POST http://127.0.0.1:8000/api/v1/tutor`

The local URL is only reachable from the same machine. For integration
between separately hosted services, use the deployed/reachable API base
URL configured for the environment; do not hard-code `127.0.0.1` in a
remotely hosted backend.

### Health-check example

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

## 2. Tutor endpoint

``` http
POST /api/v1/tutor
Content-Type: application/json
```

The backend should send one request for each student message/turn. The
API does not rely on server-side conversation history: send the recent
conversation messages with each request.

### Request body

  ----------------------------------------------------------------------------------------
  Field                   Type                          Required Description
  ----------------------- ---------------- --------------------- -------------------------
  `conversation_id`       string                             Yes Backend's conversation
                                                                 identifier. Must contain
                                                                 1--128 non-whitespace
                                                                 characters. It is echoed
                                                                 in the response.

  `message`               string                             Yes Student's latest message.
                                                                 Must not be empty or
                                                                 whitespace-only.

  `recent_messages`       array                               No Recent conversation
                                                                 history. Defaults to
                                                                 `[]`. Each item has
                                                                 `role` and `content`.

  `current_code`          string or `null`      Yes, key must be Complete code currently
                                                         present present in the editor.
                                                                 Use `null` when
                                                                 unavailable.

  `executed_code`         string or `null`      Yes, key must be Exact code submitted in
                                                         present the student's most recent
                                                                 execution. Use `null`
                                                                 when no execution is
                                                                 available.

  `output_error`          object or `null`      Yes, key must be Runtime/output error
                                                         present information available
                                                                 from the runner. Use
                                                                 `null` when unavailable.

  `validation_feedback`   object or `null`      Yes, key must be Complete Code Runner
                                                         present response from
                                                                 `POST /run?view=tutor`.
                                                                 Use `null` when no
                                                                 validation/execution
                                                                 feedback is available.
  ----------------------------------------------------------------------------------------

**Important:** The nullable fields must still be included in the JSON
request. Send `null` rather than omitting the keys.

### `recent_messages` item format

Each history item must have:

``` json
{
  "role": "user",
  "content": "The student's earlier message"
}
```

Allowed roles:

-   `user`
-   `assistant`

`content` must be a non-empty string.

Send prior conversation messages in chronological order (oldest first).
The current student message goes in the top-level `message` field; do
not duplicate it as the latest item in `recent_messages`.

### Example request

This example represents a coding-help turn where the student has not run
the code yet:

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

### Example request after a runner execution

When the Code Runner has produced tutor-view feedback, send the
**complete `view=tutor` response** in `validation_feedback`. Do not
pre-filter its fields on the backend. The Seekhein API sanitizes the
feedback before it is added to the tutor context.

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

The `validation_feedback` above is a shortened illustrative example. In
actual integration, pass the complete JSON object returned by the Code
Runner's `view=tutor` response, including its available diagnostic
fields.

If the runner has a separate output/runtime error object, send it in
`output_error`. If no such error exists, send `null`.

------------------------------------------------------------------------

## 3. Scenario handling

The backend does **not** need to send a `scenario` field. The Seekhein
context builder determines the scenario from `output_error` and
`validation_feedback`.

Current scenario selection:

  -----------------------------------------------------------------------
  Input condition                     Scenario selected internally
  ----------------------------------- -----------------------------------
  Both `output_error` and             `combined_feedback`
  `validation_feedback` are present

  Only `output_error` is present      `runtime_error`

  `validation_feedback.status` is     `runtime_error`
  `syntax_error`, `runtime_error`,
  `timeout`, `oom`, or
  `internal_error`

  Other non-null                      `submission_feedback`
  `validation_feedback`

  Both feedback fields are `null`     `coding`
  -----------------------------------------------------------------------

Do not add or send a `scenario` property unless the API contract is
explicitly changed.

------------------------------------------------------------------------

## 4. Successful response

A successful request returns JSON in this shape:

``` json
{
  "status": "success",
  "conversation_id": "conv-123",
  "answer": "Let's inspect the return statement. What happens when Python reaches it during the first loop iteration?",
  "sources": []
}
```

  -----------------------------------------------------------------------
  Field                   Type                    Description
  ----------------------- ----------------------- -----------------------
  `status`                string                  `"success"` when the
                                                  request is processed
                                                  successfully.

  `conversation_id`       string                  The same conversation
                                                  identifier sent in the
                                                  request.

  `answer`                string                  Socratic tutor response
                                                  to display to the
                                                  student.

  `sources`               array                   Retrieved
                                                  learning-material
                                                  source metadata. Treat
                                                  the entries as source
                                                  metadata; do not assume
                                                  a fixed item schema
                                                  unless separately
                                                  agreed.
  -----------------------------------------------------------------------

The frontend should display `answer` as the tutor's response. `sources`
can be used by the application if it displays learning-material
references.

------------------------------------------------------------------------

## 5. Error responses

Handle non-2xx responses rather than assuming every request succeeds.

  -----------------------------------------------------------------------
  HTTP status             Meaning                 Backend handling
  ----------------------- ----------------------- -----------------------
  `400`                   Request reached the API Read the response
                          but a message/context   `detail`; correct the
                          validation error was    request or show an
                          raised.                 appropriate error.

  `422`                   Request body failed     Check field names,
                          FastAPI/Pydantic schema types, required keys,
                          validation.             and `recent_messages`
                                                  item structure.

  `500`                   Unexpected internal API Log the
                          error.                  request/conversation
                                                  identifier and response
                                                  status; do not expose
                                                  internal server details
                                                  to the student.
  -----------------------------------------------------------------------

The API returns a generic message for unexpected internal errors rather
than exposing the underlying exception.

------------------------------------------------------------------------

## 6. Backend integration checklist

-   [ ] Send `POST /api/v1/tutor` with `Content-Type: application/json`.
-   [ ] Include `conversation_id` and the student's latest `message`.
-   [ ] Include `recent_messages` as
    `{ "role": "user" | "assistant", "content": "..." }` objects.
-   [ ] Send the complete editor contents as `current_code`, or `null`.
-   [ ] Send the exact code from the latest execution as
    `executed_code`, or `null`.
-   [ ] Include `output_error` and `validation_feedback` keys even when
    their values are `null`.
-   [ ] Pass the complete Code Runner `view=tutor` response as
    `validation_feedback`; do not filter it on the backend.
-   [ ] Do not send a `scenario` field; the API derives it.
-   [ ] Display the returned `answer` to the student.
-   [ ] Preserve and resend recent conversation history on each request.
-   [ ] Handle `400`, `422`, and `500` responses.
-   [ ] Test the full flow from the student interface through the
    backend, runner feedback, tutor API, and back to the interface.

------------------------------------------------------------------------

## 7. Important integration notes

1.  **Conversation history:** `conversation_id` is accepted and returned
    by the API, but the backend must send `recent_messages` on each
    request. Do not rely on the tutor API to retrieve prior turns by
    conversation ID.
2.  **Code fields:** `current_code` is the current editor state.
    `executed_code` is the code associated with the latest run. They may
    differ.
3.  **Runner feedback:** Send the full Code Runner tutor-view response.
    Sanitization is performed inside Seekhein before the data is used as
    tutor context.
4.  **Nullable values:** Use explicit JSON `null` for unavailable code
    or feedback values.
5.  **Deployment URL:** Configure the API base URL per environment. A
    service running remotely cannot call another machine's `127.0.0.1`
    address.

For the current request schema and response details, the interactive
FastAPI documentation at `/docs` is the source of truth for the running
API version.
