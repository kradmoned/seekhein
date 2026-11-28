# CodeRunner API & Usage Reference

> **Module:** `github.com/kradmoned/seekhein`  
> **HTTP Server:** [`cmd/runner/main.go`](file:///Users/abdulrehman/workspace/github.com/seekkhein/cmd/runner/main.go)  
> **Sandbox Package:** [`internal/sandbox`](file:///Users/abdulrehman/workspace/github.com/seekkhein/internal/sandbox/runner.go)  
> **Container Harness:** [`docker/python-sandbox/harness.py`](file:///Users/abdulrehman/workspace/github.com/seekkhein/docker/python-sandbox/harness.py)

This document explains how to interact with **CodeRunner**: its HTTP endpoints, Go package API, how submitted Python code and `unittest.TestCase` suites must be structured, how outputs are formatted across views, and complete copy-pasteable sample requests and responses.

---

## 1. Overview & Quick Start

CodeRunner executes untrusted Python 3.12 code against a `unittest.TestCase` test suite inside ephemeral, hardened Docker containers (`seekkhein-python-sandbox:latest`). You can invoke it either:

1. **Over HTTP** via the standalone server in `cmd/runner` (default `:8081`)
2. **Directly in Go** via the `internal/sandbox` package (`Runner` interface)

### Build & Run the Standalone HTTP Server

The standalone `cmd/runner` binary embeds `Dockerfile` and `harness.py` via `//go:embed` and automatically builds the sandbox Docker image on first startup if it is missing (or outdated), so you can distribute it as a single executable to any host with Docker running:

```bash
# Optional: pre-build the Python 3.12 sandbox image manually
make sandbox-image

# Start the HTTP server (listens on :8081 by default; auto-builds image if missing)
make runner
```

### Server Configuration (Environment Variables)

When running `cmd/runner`, configuration is read from the environment (invalid or non-positive integer values fall back to defaults):

| Environment Variable | Default | Description |
|---|---|---|
| `RUNNER_ADDR` | `:8081` | TCP listen address for the HTTP server |
| `SANDBOX_IMAGE` | `seekkhein-python-sandbox:latest` | Docker image name/tag for the Python sandbox |
| `SANDBOX_AUTO_BUILD` | `true` | Automatically build/update `SANDBOX_IMAGE` from the embedded `Dockerfile` & `harness.py` on startup if missing or outdated |
| `SANDBOX_MAX_CONCURRENT` | `4` | Max number of sandbox containers running concurrently |
| `SANDBOX_QUEUE_WAIT_SEC` | `10` | Seconds a request waits for a worker slot before returning `429` |
| `SANDBOX_PER_TEST_TIMEOUT_SEC` | `2` | Default per-test / per-`subTest` `SIGALRM` timeout (seconds) |
| `SANDBOX_CONTAINER_TIMEOUT_SEC` | `6` | Hard container execution deadline (seconds); must be `>=` per-test timeout |

### Endpoints & Limits Summary

| Endpoint | Purpose | Primary Caller |
|---|---|---|
| `GET /health` | Liveness check | Load balancers / local smoke checks |
| `POST /run?view=student\|tutor\|full\|both` | Execute student `code` against `tests` | Student submission flow (`student`), AI tutor (`tutor`), or combined (`both`) |
| `POST /validate` | Validate a teacher lab's reference `solution` and `tests` | Teacher lab authoring / upload flow |

**Hard Sandbox & Payload Limits (Defaults):**

| Limit | Default | Enforcement |
|---|---|---|
| Max HTTP request body | `512 KB` (`524,288` bytes) | HTTP middleware (`413`) |
| Max `code` / `solution` size | `64 KB` (`65,536` bytes) | Before worker semaphore (`413`) |
| Max `tests` size | `64 KB` (`65,536` bytes) | Before worker semaphore (`413`) |
| Captured output (`stdout` + `stderr`) | `16 KB` total / `4 KB` per test | In-container `_PipeCapture` (`stdout_truncated: true`) |
| Memory / Swap | `128 MiB` RAM, swap disabled | Docker `HostConfig` (`status: "oom"`) |
| CPU / PIDs | `0.5` vCPU (`500_000_000` nanoCPUs), `64` PIDs | Docker `HostConfig` |
| Network & Filesystem | `NetworkMode: "none"`, read-only rootfs, `/work` `8 MB` tmpfs, `/tmp` `4 MB` tmpfs, UID/GID `1000` | Docker `ContainerConfig` & `HostConfig` |

---

## 2. How CodeRunner Expects Code & Tests

### Runtime Environment

- **Python version:** Python `3.12` standard library only (`python:3.12-slim`, no third-party `pip` packages, `PYTHONDONTWRITEBYTECODE=1`).
- **No network, read-only rootfs:** Attempts to open sockets or write outside `/work` and `/tmp` raise `OSError` / `PermissionError`.
- **Execution working directory:** `/work` (ephemeral `tmpfs`, `noexec,nosuid`).

### Student / Reference Solution (`code` or `solution`)

- Written inside the container to `/work/solution.py` with `/work` prepended to `sys.path`.
- Tests import student symbols using standard Python imports:
  ```python
  from solution import two_sum
  # or
  import solution
  ```
- Any top-level `print(...)` executed while importing `solution` is captured into the top-level `stdout` field (or `top_level_stdout` in `tutor` view).

### Test Suite (`tests`)

- **In-memory only:** Compiled via `compile(test_src, "<test_suite>", "exec")` and deleted from memory before `solution.py` is imported. **No test file is ever written to `/work`.**
- **Module name:** Executed in namespace `{"__name__": "__lab_tests__"}`.
- **Strict `unittest.TestCase` discovery:**
  - The harness inspects all classes in the test namespace that subclass `unittest.TestCase` (excluding `unittest.TestCase` itself) and discovers methods whose names start with `test_` and are callable.
  - Bare top-level functions (`def test_something(): ...`) are **not** discovered (`total: 0`).
  - Supported `unittest` lifecycle hooks: `setUpClass`, `tearDownClass`, `setUp`, `tearDown`, and `self.addCleanup(...)` (`doCleanups()`).
- **Automatic `actual` & `expected` capture:**
  - The harness wraps these `unittest.TestCase` assertion methods:
    `assertEqual`, `assertAlmostEqual`, `assertListEqual`, `assertDictEqual`, `assertSetEqual`, `assertTupleEqual`, `assertCountEqual`.
  - **Argument order matters:** the **first** argument (`first`) is recorded as `actual`, and the **second** argument (`second`) is recorded as `expected`.
    ```python
    # Recommended: actual first, expected second
    self.assertEqual(two_sum([2, 7], 9), [0, 1])
    # -> actual: "[0, 1]", expected: "[0, 1]"
    ```
  - Only the outermost equality assertion call inside a test or `subTest` is recorded (`depth == 0`).
- **Test labels (`display_name`) & docstrings:**
  - The **first non-empty line** of a `test_*` method's docstring becomes `display_name` (truncated to 120 characters).
  - If there is no docstring, the method name is humanized (e.g., `test_empty_list` → `"Empty list"`).
  - In `POST /validate`, methods without a docstring (unless replaced by `subTest(msg=...)`) emit a non-blocking warning.
- **`self.subTest(msg=..., **params)` behavior:**
  - Keyword parameters `**params` are formatted into `inputs` as `k=repr(v), ...` (e.g., `nums=[2, 7], target=9`).
  - `msg` becomes that case's `display_name` (and satisfies the docstring label check).
  - **0 `subTest`s or 1 `subTest` (when the outer method passes):** produces **1** scored test entry using the method's `name` (e.g., `test_single_subtest`).
  - **`N > 1` `subTest`s:** expands into **`N` separate scored test entries** named `test_method[1]` through `test_method[N]`. If `msg` is omitted, `display_name` becomes `"<method_display_name> (case <i>/<N>)"`. If the outer method also raises an exception outside a `subTest`, an additional failed entry with `name: "test_method"` is appended.
- **Continue-on-failure & independent timers:**
  - Every `TestCase` method and every `subTest` block runs under its own `signal.SIGALRM` (`per_test_timeout_sec`).
  - Failures, runtime exceptions, and per-test timeouts do **not** abort subsequent tests; all remaining tests still run unless the hard container deadline (`ContainerTimeout`, default `6s`) expires.
- **Stream capture & truncation limits:**
  - Both `stdout` (FD 1) and `stderr` (FD 2) are merged and captured per test (up to `4 KB`) and across the entire run (up to `16 KB`). Student `print(...)` calls cannot corrupt the harness JSON result channel.
  - String truncation limits inside the harness:
    - `display_name`, `subTest(msg=...)`: `120` chars
    - `traceback[].code`, `syntax_error.code_line`: `200` chars
    - `inputs`, `expected`, `actual`: `300` chars
    - `error_message`: `512` chars
    - `detail` / `full_traceback`: `2048` chars
- **Strict JSON request parsing:**
  - All HTTP `POST` endpoints decode JSON with `DisallowUnknownFields()`. Sending unrecognized fields returns `400 Bad Request`.

---

## 3. HTTP API Reference

### `GET /health`

Liveness probe for the standalone runner server.

- **Response (`200 OK`, `application/json`):**
  ```json
  {"status":"ok"}
  ```

---

### `POST /run`

Executes submitted `code` against `tests` inside an isolated Docker container and returns the execution result formatted according to the `view` query parameter.

#### Query Parameters

| Parameter | Values | Default | Description |
|---|---|---|---|
| `view` | `student`, `tutor`, `full`, `both` | `student` | Controls which diagnostics are returned (`both` returns `{ "student": ..., "tutor": ... }` from a single container run). Any other non-empty value returns `400 Bad Request`. |

> **Note on `view=full`:** In Go (`RunResult`), `Detail`, `InternalError`, and `SyntaxErrorInfo.Source` carry `json:"-"`. Therefore, `view=full` produces the same JSON fields as `view=student`, except `view=full` retains `syntax_error` even when the syntax error originated in `tests` (`source == "tests"`), whereas `view=student` strips non-solution syntax errors. Use `view=tutor` when you need `detail`, `internal_error`, or `syntax_error.source`.

#### Request Body (`application/json`)

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `string` | Yes | Student Python source written to `/work/solution.py` (max `64 KB`) |
| `tests` | `string` | Yes | Python `unittest.TestCase` test suite compiled in-memory (max `64 KB`) |
| `per_test_timeout_sec` | `number` (`float64`) | No | Optional per-test timeout override in seconds. Values `<= 0` use server default (`2s`); values greater than `ContainerTimeout` (`6s`) are clamped to `ContainerTimeout`. |

#### Response Body (`200 OK`)

##### `view=student` (default — `StudentRunResult`)

| Field | Type | Always Present | Description |
|---|---|---|---|
| `status` | `string` | Yes | `"ok"`, `"syntax_error"`, `"runtime_error"`, `"timeout"`, `"oom"`, or `"internal_error"` |
| `score` | `int` | Yes | Integer percentage `0..100` (`passed * 100 / total`, or `0` if `total == 0`) |
| `ran` | `int` | Yes | Number of test entries executed |
| `passed` | `int` | Yes | Number of passing test entries |
| `failed` | `int` | Yes | Number of failed/timed-out test entries |
| `total` | `int` | Yes | Total discovered test entries (after `subTest` expansion) |
| `stdout` | `string` | Yes | Top-level stdout/stderr produced while importing `solution` or loading tests |
| `stdout_truncated` | `bool` | Yes | `true` if top-level stdout exceeded budget |
| `duration_ms` | `int64` | Yes | Total execution duration in milliseconds |
| `tests` | `[]StudentTestResult` | Yes | Ordered array of per-test results (`[]` if none ran) |
| `syntax_error` | `SyntaxErrorInfo` | No (`omitempty`) | Present only if a syntax/indentation error occurred in `solution.py` (suppressed if error was in `tests`) |

Each item in `tests` (`StudentTestResult`):

| Field | Type | Always Present | Description |
|---|---|---|---|
| `index` | `int` | Yes | 1-based execution order |
| `name` | `string` | Yes | Method name (e.g., `"test_add"`) or expanded subTest (`"test_cases[1]"`) |
| `display_name` | `string` | Yes | Docstring first line, `subTest(msg=...)`, or humanized `name` |
| `status` | `string` | Yes | `"passed"`, `"failed"`, `"timeout"`, or `"not_run"` |
| `passed` | `bool` | Yes | `true` if `status == "passed"` |
| `inputs` | `string` | No (`omitempty`) | Formatted `subTest` kwargs (`"a=1, b=2"`) |
| `expected` | `string` | No (`omitempty`) | `repr(...)` of expected value from equality assertion |
| `actual` | `string` | No (`omitempty`) | `repr(...)` of actual value from equality assertion |
| `error_type` | `string` | No (`omitempty`) | Exception class name (e.g., `"AssertionError"`, `"IndexError"`, `"TimeoutError"`) |
| `error_message` | `string` | No (`omitempty`) | Exception message (max 512 chars) |
| `traceback` | `[]TraceFrame` | No (`omitempty`) | Stack frames strictly from `solution.py` (`{line, function, code}`); test frames are stripped |
| `stdout` | `string` | No (`omitempty`) | Per-test captured stdout/stderr |
| `stdout_truncated` | `bool` | No (`omitempty`) | `true` if per-test stdout exceeded `4 KB` or remaining total budget |
| `duration_ms` | `int64` | Yes | Duration of this test case in milliseconds |

`SyntaxErrorInfo` (`view=student` / `view=full`):

| Field | Type | Always Present | Description |
|---|---|---|---|
| `error_type` | `string` | Yes | `"SyntaxError"`, `"IndentationError"`, or `"TabError"` |
| `error_message` | `string` | No (`omitempty`) | Python syntax error message |
| `line` | `int` | Yes | 1-based line number |
| `code_line` | `string` | No (`omitempty`) | Stripped offending source line |

##### `view=tutor` (`TutorRunContext`)

| Field | Type | Always Present | Description |
|---|---|---|---|
| `status` | `string` | Yes | Run status (`"ok"`, `"syntax_error"`, `"runtime_error"`, `"timeout"`, `"oom"`, `"internal_error"`) |
| `score` | `int` | Yes | Integer percentage `0..100` |
| `ran` | `int` | Yes | Number of executed tests |
| `passed` | `int` | Yes | Number of passed tests |
| `failed` | `int` | Yes | Number of failed/timed-out tests |
| `total` | `int` | Yes | Total discovered tests |
| `duration_ms` | `int64` | Yes | Total run duration in milliseconds |
| `passed_tests` | `[]string` | Yes | Names of passing test entries (`[]` if none) |
| `failures` | `[]TutorTestFailure` | Yes | All failing/timed-out test entries with full `detail` (`[]` if none) |
| `syntax_error` | `TutorSyntaxError` | No (`omitempty`) | Includes `source` (`"solution"` or `"tests"`), `error_type`, `error_message`, `line`, `code_line` |
| `top_level_stdout` | `string` | No (`omitempty`) | Top-level import/setup stdout |
| `internal_error` | `string` | No (`omitempty`) | Full import-time traceback, timeout/OOM reason, or container failure message |

Each item in `failures` (`TutorTestFailure`) has the same fields as `StudentTestResult` (minus `passed` and `stdout_truncated`), plus:
- `detail` (`string`, `omitempty`): Full unredacted Python traceback (including `<test_suite>` frames, max 2048 chars) or timeout message.

##### `view=both` (Combined Response)

Runs the sandbox container once and returns both views in a single JSON object so backends (e.g., Next.js) can forward `student` directly to the browser while persisting `tutor` server-side:

| Field | Type | Always Present | Description |
|---|---|---|---|
| `student` | `StudentRunResult` | Yes | Browser-safe student payload (same shape as `view=student`) |
| `tutor` | `TutorRunContext` | Yes | Server-side AI tutor payload (same shape as `view=tutor`) |

#### HTTP Status Codes for `POST /run`

| HTTP Status | Meaning |
|---|---|
| `200 OK` | Request was processed. **Includes** test failures, student/test syntax errors, import runtime errors, per-test/container timeouts, OOM kills, and sandbox `internal_error` (inspect `"status"`). |
| `400 Bad Request` | Invalid `view` query param, malformed JSON, wrong field types, or unknown JSON field. |
| `413 Payload Too Large` | Request body `> 512 KB`, `code > 64 KB`, or `tests > 64 KB`. |
| `429 Too Many Requests` | All container worker slots saturated past `QueueWaitTimeout` (`ErrQueueFull`). |
| `500 Internal Server Error` | Unexpected runner error. |
| `503 Service Unavailable` | Docker daemon unreachable or sandbox image missing (`ErrSandboxUnavailable`). |

---

### `POST /validate`

Validates a teacher-authored lab by running the reference `solution` against `tests` and checking authoring quality gates.

#### Request Body (`application/json`)

| Field | Type | Required | Description |
|---|---|---|---|
| `solution` | `string` | Yes | Reference solution Python source (**note:** field is `solution`, not `code`; max `64 KB`) |
| `tests` | `string` | Yes | Lab `unittest.TestCase` test suite (max `64 KB`) |

> **Important:** `POST /validate` does **not** accept `per_test_timeout_sec` (passing it returns `400 Bad Request` due to `DisallowUnknownFields()`).

#### Response Body (`ValidationResult`)

| Field | Type | Always Present | Description |
|---|---|---|---|
| `valid` | `bool` | Yes | `true` iff `status == "ok"`, `total_tests >= 1`, and `passed_tests == total_tests` |
| `summary` | `string` | Yes | Human-readable pass/failure reason |
| `status` | `string` | Yes | Underlying `RunStatus` |
| `duration_ms` | `int64` | Yes | Total execution duration in milliseconds |
| `total_tests` | `int` | Yes | Total discovered tests |
| `ran_tests` | `int` | Yes | Number of executed tests |
| `passed_tests` | `int` | Yes | Number of passed tests |
| `failed_tests` | `int` | Yes | Number of failed/timed-out tests |
| `syntax_error` | `TeacherSyntaxError` | No (`omitempty`) | Syntax error in either `"solution"` or `"tests"` (`source`, `error_type`, `error_message`, `line`, `code_line`) |
| `stdout` | `string` | No (`omitempty`) | Top-level stdout |
| `tests` | `[]TeacherTestDiagnostic` | Yes | Full per-test diagnostics (uses `full_traceback` instead of filtered `traceback`) |
| `warnings` | `[]string` | No (`omitempty`) | Non-blocking authoring warnings: (1) tests taking `> 50%` of `PerTestTimeout`, (2) test methods without a docstring label (deduplicated across expanded `subTest`s) |

#### HTTP Status Codes for `POST /validate`

| HTTP Status | Meaning |
|---|---|
| `200 OK` | Lab is valid (`valid: true`: all `>= 1` tests ran and passed). May still include non-blocking `warnings`. |
| `422 Unprocessable Entity` | Lab is invalid (`valid: false`: 0 tests discovered, one or more tests failed, syntax error, runtime error, timeout, or OOM). |
| `400` / `413` / `429` / `500` / `503` | Same request/infrastructure errors as `POST /run`. |

---

## 4. Status & Field Visibility Matrix

### Top-Level `status` (`RunStatus`)

| `status` | Trigger | `score` | `tests` |
|---|---|---|---|
| `"ok"` | Container exited cleanly and `unittest` cases ran (includes partial/all failures and per-test timeouts) | `(passed * 100) // total` (or `0` if `total == 0`) | Populated with 1 entry per test / expanded `subTest` |
| `"syntax_error"` | `SyntaxError` / `IndentationError` compiling `tests` or `solution.py` | `0` | `[]` |
| `"runtime_error"` | Uncaught exception while importing `solution.py` (e.g., `ImportError`, `ZeroDivisionError`) or executing test module top-level code | `0` | `[]` |
| `"timeout"` | Top-level import/setup exceeded `per_test_timeout_sec` OR container exceeded `ContainerTimeout` (`6s`) | `0` | `[]` |
| `"oom"` | Container exceeded `128 MiB` RAM (`OOMKilled` or exit code `137` with empty/invalid output) | `0` | `[]` |
| `"internal_error"` | Docker wait error, empty output without OOM, or unparseable harness output | `0` | `[]` |

### Per-Test `status` (`TestStatus`)

| `status` | `passed` | Meaning |
|---|---|---|
| `"passed"` | `true` | Test method or `subTest` completed without error |
| `"failed"` | `false` | Assertion failure, uncaught exception, or `setUp`/`setUpClass`/`tearDown`/`doCleanups` error |
| `"timeout"` | `false` | Individual test, `subTest`, or lifecycle hook exceeded `per_test_timeout_sec` (`error_type: "TimeoutError"`) |
| `"not_run"` | `false` | Reserved `TestStatus` constant for unexecuted tests |

### Field Visibility Across Views

| Information | `POST /run` (`student`) | `POST /run` (`full`) | `POST /run?view=tutor` | `POST /validate` |
|---|---|---|---|---|
| `inputs`, `expected`, `actual` | Yes | Yes | On failures | Yes |
| `traceback` (`solution.py` frames only) | Yes | Yes | On failures | Replaced by `full_traceback` |
| Raw traceback (`<test_suite>` + `solution.py`) | **Stripped** | **Stripped** | Yes (`failures[].detail`) | Yes (`tests[].full_traceback`) |
| `syntax_error` from `solution` | Yes (no `source` field) | Yes (no `source` field) | Yes (`source: "solution"`) | Yes (`source: "solution"`) |
| `syntax_error` from `tests` | **Stripped** | Yes (no `source` field) | Yes (`source: "tests"`) | Yes (`source: "tests"`) |
| `internal_error` | **Stripped** | **Stripped** | Yes (`internal_error`) | Summarized in `summary` |

---

## 5. Sample Requests & Outputs

All examples assume the server is running on `http://localhost:8081`.

### 5.1 Health Check (`GET /health`)

```bash
curl -s http://localhost:8081/health
```

**Response (`200 OK`):**

```json
{"status":"ok"}
```

---

### 5.2 All Tests Passing (`POST /run`, Default `student` View)

```bash
curl -s -X POST http://localhost:8081/run \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "def add(a, b):\n    return a + b\n",
    "tests": "import unittest\nfrom solution import add\n\nclass TestAdd(unittest.TestCase):\n    def test_positives(self):\n        \"\"\"Adds two positive integers\"\"\"\n        self.assertEqual(add(2, 3), 5)\n\n    def test_negatives(self):\n        self.assertEqual(add(-1, -4), -5)\n"
  }'
```

**Response (`200 OK`):**

```json
{
  "status": "ok",
  "score": 100,
  "ran": 2,
  "passed": 2,
  "failed": 0,
  "total": 2,
  "stdout": "",
  "stdout_truncated": false,
  "duration_ms": 12,
  "tests": [
    {
      "index": 1,
      "name": "test_positives",
      "display_name": "Adds two positive integers",
      "status": "passed",
      "passed": true,
      "expected": "5",
      "actual": "5",
      "duration_ms": 0
    },
    {
      "index": 2,
      "name": "test_negatives",
      "display_name": "Negatives",
      "status": "passed",
      "passed": true,
      "expected": "-5",
      "actual": "-5",
      "duration_ms": 0
    }
  ]
}
```

---

### 5.3 Partial Pass with `subTest` Expansion, Assertion Diff & Filtered Traceback (`student` View)

Here `two_sum` prints to stdout, crashes with `IndexError` on `[]`, and returns the wrong indices for `[3, 3]`. Because `test_examples` runs 3 `subTest`s, it expands into `test_examples[1..3]`, while `test_single_subtest` has 1 `subTest` and stays a single entry.

```bash
curl -s -X POST http://localhost:8081/run \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "def two_sum(nums, target):\n    print(f\"checking nums={nums}\")\n    first = nums[0]\n    if nums == [3, 3]:\n        return [0, 0]\n    return [0, 1]\n",
    "tests": "import unittest\nfrom solution import two_sum\n\nclass TestTwoSum(unittest.TestCase):\n    def test_examples(self):\n        \"\"\"Finds two indices summing to target\"\"\"\n        cases = [\n            (\"Finds matching pair in basic list\", [2, 7, 11, 15], 9, [0, 1]),\n            (\"Returns empty list on empty input\", [], 5, []),\n            (\"Does not reuse the same index twice\", [3, 3], 6, [0, 1]),\n        ]\n        for label, nums, target, expected in cases:\n            with self.subTest(msg=label, nums=nums, target=target):\n                self.assertEqual(two_sum(nums, target), expected)\n\n    def test_single_subtest(self):\n        \"\"\"Handles negative integers\"\"\"\n        with self.subTest(nums=[-3, 4, 3, 90], target=0):\n            self.assertEqual(two_sum([-3, 4, 3, 90], 0), [0, 1])\n"
  }'
```

**Response (`200 OK`):**

```json
{
  "status": "ok",
  "score": 50,
  "ran": 4,
  "passed": 2,
  "failed": 2,
  "total": 4,
  "stdout": "",
  "stdout_truncated": false,
  "duration_ms": 14,
  "tests": [
    {
      "index": 1,
      "name": "test_examples[1]",
      "display_name": "Finds matching pair in basic list",
      "status": "passed",
      "passed": true,
      "inputs": "nums=[2, 7, 11, 15], target=9",
      "expected": "[0, 1]",
      "actual": "[0, 1]",
      "stdout": "checking nums=[2, 7, 11, 15]\n",
      "duration_ms": 1
    },
    {
      "index": 2,
      "name": "test_examples[2]",
      "display_name": "Returns empty list on empty input",
      "status": "failed",
      "passed": false,
      "inputs": "nums=[], target=5",
      "error_type": "IndexError",
      "error_message": "list index out of range",
      "traceback": [
        {
          "line": 3,
          "function": "two_sum",
          "code": "first = nums[0]"
        }
      ],
      "stdout": "checking nums=[]\n",
      "duration_ms": 1
    },
    {
      "index": 3,
      "name": "test_examples[3]",
      "display_name": "Does not reuse the same index twice",
      "status": "failed",
      "passed": false,
      "inputs": "nums=[3, 3], target=6",
      "expected": "[0, 1]",
      "actual": "[0, 0]",
      "error_type": "AssertionError",
      "error_message": "Lists differ: [0, 0] != [0, 1]\n\nFirst differing element 1:\n0\n1\n\n- [0, 0]\n+ [0, 1]",
      "stdout": "checking nums=[3, 3]\n",
      "duration_ms": 1
    },
    {
      "index": 4,
      "name": "test_single_subtest",
      "display_name": "Handles negative integers",
      "status": "passed",
      "passed": true,
      "inputs": "nums=[-3, 4, 3, 90], target=0",
      "expected": "[0, 1]",
      "actual": "[0, 1]",
      "stdout": "checking nums=[-3, 4, 3, 90]\n",
      "duration_ms": 1
    }
  ]
}
```

---

### 5.4 Same Run in AI Tutor View (`POST /run?view=tutor`) & Combined View (`POST /run?view=both`)

```bash
curl -s -X POST "http://localhost:8081/run?view=tutor" \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "def two_sum(nums, target):\n    print(f\"checking nums={nums}\")\n    first = nums[0]\n    if nums == [3, 3]:\n        return [0, 0]\n    return [0, 1]\n",
    "tests": "import unittest\nfrom solution import two_sum\n\nclass TestTwoSum(unittest.TestCase):\n    def test_examples(self):\n        \"\"\"Finds two indices summing to target\"\"\"\n        cases = [\n            (\"Finds matching pair in basic list\", [2, 7, 11, 15], 9, [0, 1]),\n            (\"Returns empty list on empty input\", [], 5, []),\n            (\"Does not reuse the same index twice\", [3, 3], 6, [0, 1]),\n        ]\n        for label, nums, target, expected in cases:\n            with self.subTest(msg=label, nums=nums, target=target):\n                self.assertEqual(two_sum(nums, target), expected)\n\n    def test_single_subtest(self):\n        \"\"\"Handles negative integers\"\"\"\n        with self.subTest(nums=[-3, 4, 3, 90], target=0):\n            self.assertEqual(two_sum([-3, 4, 3, 90], 0), [0, 1])\n"
  }'
```

**Response (`200 OK`, `view=tutor`):**

```json
{
  "status": "ok",
  "score": 50,
  "ran": 4,
  "passed": 2,
  "failed": 2,
  "total": 4,
  "duration_ms": 14,
  "passed_tests": [
    "test_examples[1]",
    "test_single_subtest"
  ],
  "failures": [
    {
      "index": 2,
      "name": "test_examples[2]",
      "display_name": "Returns empty list on empty input",
      "status": "failed",
      "inputs": "nums=[], target=5",
      "error_type": "IndexError",
      "error_message": "list index out of range",
      "traceback": [
        {
          "line": 3,
          "function": "two_sum",
          "code": "first = nums[0]"
        }
      ],
      "stdout": "checking nums=[]\n",
      "detail": "Traceback (most recent call last):\n  File \"<test_suite>\", line 14, in test_examples\n    self.assertEqual(two_sum(nums, target), expected)\n  File \"/work/solution.py\", line 3, in two_sum\n    first = nums[0]\nIndexError: list index out of range\n",
      "duration_ms": 1
    },
    {
      "index": 3,
      "name": "test_examples[3]",
      "display_name": "Does not reuse the same index twice",
      "status": "failed",
      "inputs": "nums=[3, 3], target=6",
      "expected": "[0, 1]",
      "actual": "[0, 0]",
      "error_type": "AssertionError",
      "error_message": "Lists differ: [0, 0] != [0, 1]\n\nFirst differing element 1:\n0\n1\n\n- [0, 0]\n+ [0, 1]",
      "stdout": "checking nums=[3, 3]\n",
      "detail": "Traceback (most recent call last):\n  File \"<test_suite>\", line 14, in test_examples\n    self.assertEqual(two_sum(nums, target), expected)\nAssertionError: Lists differ: [0, 0] != [0, 1]...\n",
      "duration_ms": 1
    }
  ]
}
```

With `POST /run?view=both`, the response wraps both payloads from that single execution:

```json
{
  "student": {
    "status": "ok",
    "score": 50,
    "ran": 4,
    "passed": 2,
    "failed": 2,
    "total": 4,
    "stdout": "",
    "stdout_truncated": false,
    "duration_ms": 14,
    "tests": []
  },
  "tutor": {
    "status": "ok",
    "score": 50,
    "ran": 4,
    "passed": 2,
    "failed": 2,
    "total": 4,
    "duration_ms": 14,
    "passed_tests": ["test_examples[1]", "test_single_subtest"],
    "failures": []
  }
}
```
*(In live responses, `student.tests` and `tutor.failures` contain the full arrays shown in Sections 5.3 and 5.4.)*

---

### 5.5 Syntax Error in Student Code (`POST /run`)

```bash
curl -s -X POST http://localhost:8081/run \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "def add(a, b)\n    return a + b\n",
    "tests": "import unittest\nfrom solution import add\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(add(1, 2), 3)\n"
  }'
```

**Response (`200 OK`, `student` view):**

```json
{
  "status": "syntax_error",
  "score": 0,
  "ran": 0,
  "passed": 0,
  "failed": 0,
  "total": 0,
  "stdout": "",
  "stdout_truncated": false,
  "duration_ms": 9,
  "tests": [],
  "syntax_error": {
    "error_type": "SyntaxError",
    "error_message": "expected ':'",
    "line": 1,
    "code_line": "def add(a, b)"
  }
}
```

> If the syntax error was in `tests` instead of `code`, `view=student` omits `syntax_error` completely (`status` remains `"syntax_error"`), while `view=tutor` includes `"syntax_error": {"source": "tests", ...}`.

---

### 5.6 Import-Time Runtime Error (`POST /run`)

Occurs when `from solution import missing_fn` fails or top-level student code raises an exception during `import solution`.

```bash
curl -s -X POST "http://localhost:8081/run?view=tutor" \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "print(\"loading solution\")\ndef wrong_name():\n    return 1\n",
    "tests": "import unittest\nfrom solution import missing_fn\nclass T(unittest.TestCase):\n    def test_a(self): pass\n"
  }'
```

**Response (`200 OK`, `tutor` view):**

```json
{
  "status": "runtime_error",
  "score": 0,
  "ran": 0,
  "passed": 0,
  "failed": 0,
  "total": 0,
  "duration_ms": 11,
  "passed_tests": [],
  "failures": [],
  "top_level_stdout": "loading solution\n",
  "internal_error": "ImportError: cannot import name 'missing_fn' from 'solution' (/work/solution.py)\nTraceback (most recent call last):\n  File \"<test_suite>\", line 2, in <module>\nImportError: cannot import name 'missing_fn' from 'solution' (/work/solution.py)\n"
}
```

In `view=student`, `internal_error` is omitted and `top_level_stdout` appears in `stdout`.

---

### 5.7 Per-Test Timeout vs. Hard Container Timeout (`POST /run`)

#### A. Single Test Times Out (`per_test_timeout_sec` override, remaining tests continue)

```bash
curl -s -X POST http://localhost:8081/run \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "def spin():\n    while True:\n        pass\n\ndef ok():\n    return 42\n",
    "tests": "import unittest\nfrom solution import spin, ok\n\nclass T(unittest.TestCase):\n    def test_spin(self):\n        \"\"\"Infinite loop test\"\"\"\n        self.assertEqual(spin(), 42)\n\n    def test_ok(self):\n        \"\"\"Fast test continues after timeout\"\"\"\n        self.assertEqual(ok(), 42)\n",
    "per_test_timeout_sec": 0.5
  }'
```

**Response (`200 OK`, `student` view):**

```json
{
  "status": "ok",
  "score": 50,
  "ran": 2,
  "passed": 1,
  "failed": 1,
  "total": 2,
  "stdout": "",
  "stdout_truncated": false,
  "duration_ms": 515,
  "tests": [
    {
      "index": 1,
      "name": "test_spin",
      "display_name": "Infinite loop test",
      "status": "timeout",
      "passed": false,
      "error_type": "TimeoutError",
      "error_message": "Test exceeded 0.5s time limit",
      "duration_ms": 501
    },
    {
      "index": 2,
      "name": "test_ok",
      "display_name": "Fast test continues after timeout",
      "status": "passed",
      "passed": true,
      "expected": "42",
      "actual": "42",
      "duration_ms": 0
    }
  ]
}
```

#### B. Hard Container Timeout (`status: "timeout"`)

If cumulative execution across tests exceeds `ContainerTimeout` (default `6s`), the container is killed and force-removed:

```json
{
  "status": "timeout",
  "score": 0,
  "ran": 0,
  "passed": 0,
  "failed": 0,
  "total": 0,
  "stdout": "",
  "stdout_truncated": false,
  "duration_ms": 6004,
  "tests": []
}
```

---

### 5.8 Out of Memory (`POST /run`)

```bash
curl -s -X POST http://localhost:8081/run \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "data = bytearray(512 * 1024 * 1024)\n",
    "tests": "import unittest\nimport solution\nclass T(unittest.TestCase):\n    def test_a(self): pass\n"
  }'
```

**Response (`200 OK`, `student` view):**

```json
{
  "status": "oom",
  "score": 0,
  "ran": 0,
  "passed": 0,
  "failed": 0,
  "total": 0,
  "stdout": "",
  "stdout_truncated": false,
  "duration_ms": 48,
  "tests": []
}
```

---

### 5.9 Teacher Lab Validation Passing with Non-Blocking Warnings (`POST /validate`)

Notice the request uses `"solution"` (not `"code"`). Here `test_no_doc` lacks a docstring, so the lab passes (`200 OK`, `valid: true`) with an authoring warning.

```bash
curl -s -X POST http://localhost:8081/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "solution": "def add(a, b):\n    return a + b\n",
    "tests": "import unittest\nfrom solution import add\n\nclass TestAdd(unittest.TestCase):\n    def test_basic(self):\n        \"\"\"Adds two integers\"\"\"\n        self.assertEqual(add(1, 2), 3)\n\n    def test_no_doc(self):\n        self.assertEqual(add(0, 0), 0)\n"
  }'
```

**Response (`200 OK`):**

```json
{
  "valid": true,
  "summary": "All 2 tests passed against reference solution",
  "status": "ok",
  "duration_ms": 10,
  "total_tests": 2,
  "ran_tests": 2,
  "passed_tests": 2,
  "failed_tests": 0,
  "tests": [
    {
      "index": 1,
      "name": "test_basic",
      "display_name": "Adds two integers",
      "status": "passed",
      "passed": true,
      "expected": "3",
      "actual": "3",
      "duration_ms": 0
    },
    {
      "index": 2,
      "name": "test_no_doc",
      "display_name": "No doc",
      "status": "passed",
      "passed": true,
      "expected": "0",
      "actual": "0",
      "duration_ms": 0
    }
  ],
  "warnings": [
    "test method(s) lack a docstring label: test_no_doc"
  ]
}
```

---

### 5.10 Teacher Lab Validation Failing (`POST /validate` → `422`)

#### A. Reference Solution Fails a Test (includes `full_traceback`)

```bash
curl -i -s -X POST http://localhost:8081/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "solution": "def add(a, b):\n    return a - b\n",
    "tests": "import unittest\nfrom solution import add\nclass TestAdd(unittest.TestCase):\n    def test_basic(self):\n        \"\"\"Adds two integers\"\"\"\n        self.assertEqual(add(2, 3), 5)\n"
  }'
```

**Response (`422 Unprocessable Entity`):**

```json
{
  "valid": false,
  "summary": "1 of 1 tests failed against reference solution",
  "status": "ok",
  "duration_ms": 11,
  "total_tests": 1,
  "ran_tests": 1,
  "passed_tests": 0,
  "failed_tests": 1,
  "tests": [
    {
      "index": 1,
      "name": "test_basic",
      "display_name": "Adds two integers",
      "status": "failed",
      "passed": false,
      "expected": "5",
      "actual": "-1",
      "error_type": "AssertionError",
      "error_message": "-1 != 5",
      "full_traceback": "Traceback (most recent call last):\n  File \"<test_suite>\", line 6, in test_basic\n    self.assertEqual(add(2, 3), 5)\nAssertionError: -1 != 5\n",
      "duration_ms": 0
    }
  ]
}
```

#### B. Zero `unittest.TestCase` Tests Discovered

```bash
curl -i -s -X POST http://localhost:8081/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "solution": "x = 1\n",
    "tests": "def test_top_level():\n    assert True\n"
  }'
```

**Response (`422 Unprocessable Entity`):**

```json
{
  "valid": false,
  "summary": "lab must define at least 1 unittest.TestCase test method",
  "status": "ok",
  "duration_ms": 8,
  "total_tests": 0,
  "ran_tests": 0,
  "passed_tests": 0,
  "failed_tests": 0,
  "tests": []
}
```

---

### 5.11 HTTP Error Responses

| Condition | Status | Body |
|---|---|---|
| `POST /run?view=admin` | `400` | `{"error":"invalid view parameter (must be student, tutor, full, or both)"}` |
| Unknown JSON field (e.g., `{"code":"...","tests":"...","extra":1}`) or invalid JSON | `400` | `{"error":"invalid JSON request body"}` |
| Request body `> 512 KB` | `413` | `{"error":"request body too large"}` |
| `code` / `solution` `> 64 KB` | `413` | `{"error":"sandbox: code exceeds maximum size: ..."}` |
| `tests` `> 64 KB` | `413` | `{"error":"sandbox: tests exceed maximum size: ..."}` |
| Worker pool full longer than `QueueWaitTimeout` | `429` | `{"error":"sandbox: worker queue saturated"}` |
| Docker daemon stopped or `seekkhein-python-sandbox:latest` missing | `503` | `{"error":"sandbox: docker daemon or image unavailable: ..."}` |

---

## 6. Embedded Go Package API (`internal/sandbox`)

Go services in this repository can call `internal/sandbox` directly without running `cmd/runner`:

```go
package main

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/kradmoned/seekhein/internal/sandbox"
)

func main() {
	ctx := context.Background()

	cfg := sandbox.DefaultConfig()
	cfg.MaxConcurrent = 4
	cfg.PerTestTimeout = 2 * time.Second
	cfg.ContainerTimeout = 6 * time.Second

	// Fails fast if Docker daemon is down or sandbox image is not built.
	runner, err := sandbox.NewRunner(ctx, cfg)
	if err != nil {
		log.Fatalf("init runner: %v", err)
	}
	defer runner.Close()

	// 1. Run student code
	res, err := runner.Run(ctx, sandbox.RunRequest{
		Code:  "def add(a, b): return a + b",
		Tests: "import unittest\nfrom solution import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)",
	})
	if err != nil {
		switch {
		case errors.Is(err, sandbox.ErrCodeTooLarge), errors.Is(err, sandbox.ErrTestsTooLarge):
			// return 413
		case errors.Is(err, sandbox.ErrQueueFull):
			// return 429
		case errors.Is(err, sandbox.ErrSandboxUnavailable):
			// return 503
		}
		log.Fatalf("run: %v", err)
	}

	studentPayload := res.ToStudentView() // safe for browser response
	tutorPayload := res.ToTutorContext()  // safe for server-side AI tutor
	_ = studentPayload
	_ = tutorPayload

	// 2. Validate a teacher lab
	validation, err := runner.ValidateLab(ctx, solutionCode, testCode)
	if err != nil {
		log.Fatalf("validate: %v", err)
	}
	if !validation.Valid {
		log.Printf("invalid lab: %s", validation.Summary)
	}
}
```
