This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Lab fetch API

Both GET routes require a Supabase access token in `Authorization: Bearer <token>`.
Students and teachers can read all labs. Responses contain only student-visible
fields, and successful responses use `Cache-Control: private, no-store`.

List labs, newest first (an empty database returns `[]`):

```bash
curl http://localhost:3000/api/labs \
  -H "Authorization: Bearer $TOKEN"
```

HTTP 200:

```json
[{"id":"11111111-1111-4111-8111-111111111111","title":"Addition"}]
```

Fetch a lab using an ID returned by the list or upload route:

```bash
curl "http://localhost:3000/api/labs/$LAB_ID" \
  -H "Authorization: Bearer $TOKEN"
```

HTTP 200 (example contents):

```json
{"id":"11111111-1111-4111-8111-111111111111","title":"Addition","instructions":"# Addition\nImplement add(a, b).\n","starter":"def add(a, b):\n    pass\n"}
```

The current database has no `submissions` table. As a temporary contract,
`solved` and `last_code` are omitted until submission storage is implemented.
The frontend can initialize the editor with `starter`.
Hidden tests and reference solutions are never returned.

Errors use `{"error":"message"}`:

- Missing or invalid credentials: HTTP 401 (a verified user without a profile gets 403).
- Invalid lab UUID: HTTP 400, `{"error":"Invalid lab ID"}`.
- Unknown lab UUID: HTTP 404, `{"error":"Lab not found"}`.
- Database failure: HTTP 500 with a generic error message.

These routes reuse `DATABASE_URL` and `SUPABASE_URL` from `.env.local`.
No new environment variables or migrations are required.

## Run a lab

`POST /api/labs/{id}/run` requires authentication and accepts only
`{"code":"Python source from the student's editor"}`. Both students and teachers
can run a lab. The backend fetches the complete `tests` text from Postgres and
sends `{code, tests}` to the runner's `/run?view=student` endpoint. It does not use
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
  "passed": 2,
  "total": 2
}
```

`status` extends the planned response so the frontend can distinguish `ok`,
`syntax_error`, `runtime_error`, `timeout`, and `oom`, including when no tests
finish. HTTP 200 means execution was processed, not that the code passed.
Failed cases use fixed messages: `Test failed`, `Test timed out`, or
`Test was not run`. Names are generated labels, not private Python method names.

The supplied CodeRunner reference exposes inputs, expected/actual values, and
assertion messages even in `student` view. The backend deliberately constructs
its own response and omits those fields, all stdout, tracebacks, raw names,
docstrings, and source snippets because they could reveal hidden test data.

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

The upload limit remains 1 MiB per file. Consequently a lab may upload
successfully but exceed the runner's stricter 64 KiB test limit when executed.
Upload still does not call `/validate` or the runner.

The current CodeRunner requires `unittest.TestCase` methods. Bare functions and
the old `expect(...)` demo are incompatible. A compatible complete test file is:

```python
import unittest
from solution import add

class TestAdd(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(add(2, 3), 5)

    def test_negative(self):
        self.assertEqual(add(-1, -4), -5)
```

Runs are not persisted yet. This feature adds no submissions migration, and
`solved` / `last_code` remain deferred. The runner's Docker isolation and
internal-key enforcement must be verified against its deployment separately.

Run backend checks with `npm test`, `npm run lint`, and
`npx tsc --noEmit --incremental false`. The tests exercise the real run handler
and runner adapter with mocked auth, database, and HTTP boundaries; they do not
verify the live Docker service.

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
