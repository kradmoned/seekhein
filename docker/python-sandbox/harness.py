#!/usr/bin/env python3
"""In-container test execution harness for Seekkhein Python labs."""

import json
import os
import signal
import sys
import threading
import time
import traceback
import unittest


class _TestTimeoutError(Exception):
    pass


def _timeout_handler(_signum, _frame):
    raise _TestTimeoutError("Test execution exceeded time limit")


class _PipeCapture:
    """Captures FD 1 and FD 2 via a pipe with a bounded reader thread."""

    def __init__(self, max_bytes: int, devnull_fd: int) -> None:
        self.max_bytes = max(0, max_bytes)
        self.devnull_fd = devnull_fd
        self._buf = bytearray()
        self._truncated = False
        self._lock = threading.Lock()
        self._r_fd = -1
        self._thread: threading.Thread | None = None
        self._stopped = False

    def start(self) -> None:
        _safe_flush()
        r_fd, w_fd = os.pipe()
        self._r_fd = r_fd
        os.dup2(w_fd, 1)
        os.dup2(w_fd, 2)
        os.close(w_fd)
        self._thread = threading.Thread(target=self._drain, daemon=True)
        self._thread.start()

    def _drain(self) -> None:
        while True:
            try:
                chunk = os.read(self._r_fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            with self._lock:
                remaining = self.max_bytes - len(self._buf)
                if remaining > 0:
                    self._buf.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    self._truncated = True

    def stop(self) -> tuple[str, bool]:
        if self._stopped:
            return "", False
        self._stopped = True
        _safe_flush()
        try:
            os.dup2(self.devnull_fd, 1)
            os.dup2(self.devnull_fd, 2)
        except OSError:
            pass
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        if self._r_fd >= 0:
            try:
                os.close(self._r_fd)
            except OSError:
                pass
            self._r_fd = -1
        with self._lock:
            text = bytes(self._buf).decode("utf-8", errors="replace")
            truncated = self._truncated
        return text, truncated


def _safe_flush() -> None:
    for stream in (sys.stdout, sys.stderr):
        if stream is not None:
            try:
                stream.flush()
            except Exception:
                pass


def _truncate_str(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3] + "..."


def _fmt_value(val: object, limit: int = 300) -> str:
    return _truncate_str(repr(val), limit)


def _fmt_inputs(inputs: object, limit: int = 300) -> str:
    if isinstance(inputs, str):
        return _truncate_str(inputs, limit)
    if isinstance(inputs, dict):
        parts = [f"{k}={repr(v)}" for k, v in inputs.items()]
        return _truncate_str(", ".join(parts), limit)
    return _truncate_str(repr(inputs), limit)


def _humanize_name(name: str) -> str:
    stripped = name
    if stripped.startswith("test_hidden_"):
        stripped = stripped[len("test_hidden_") :]
    elif stripped.startswith("test_"):
        stripped = stripped[len("test_") :]
    words = stripped.replace("_", " ").strip()
    if not words:
        return name
    return words[0].upper() + words[1:]


def _extract_display_name(fn: object, fallback_name: str) -> tuple[str, bool]:
    doc = getattr(fn, "__doc__", None)
    if isinstance(doc, str):
        for line in doc.splitlines():
            cleaned = line.strip()
            if cleaned:
                return _truncate_str(cleaned, 120), True
    return _humanize_name(fallback_name), False


def _extract_solution_traceback(
    exc: BaseException, solution_real: str, solution_lines: list[str]
) -> list[dict[str, object]]:
    frames: list[dict[str, object]] = []
    tb = exc.__traceback__
    if tb is None:
        return frames
    for frame in traceback.extract_tb(tb):
        try:
            frame_real = os.path.realpath(frame.filename)
        except OSError:
            frame_real = frame.filename
        if frame_real != solution_real and frame.filename != solution_real:
            continue
        code = (frame.line or "").strip()
        if not code and 1 <= frame.lineno <= len(solution_lines):
            code = solution_lines[frame.lineno - 1].strip()
        frames.append(
            {
                "line": frame.lineno,
                "function": frame.name,
                "code": _truncate_str(code, 200),
            }
        )
    return frames


def _full_traceback(exc: BaseException, limit: int = 2048) -> str:
    formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    return _truncate_str(formatted, limit)


def _get_code_line(lines: list[str], lineno: int | None) -> str:
    if lineno is None or lineno < 1 or lineno > len(lines):
        return ""
    return _truncate_str(lines[lineno - 1].strip(), 200)


def _emit_and_exit(result_fd: int, payload: dict[str, object]) -> None:
    data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
    view = memoryview(data)
    written = 0
    while written < len(view):
        n = os.write(result_fd, view[written:])
        if n <= 0:
            break
        written += n
    try:
        os.close(result_fd)
    except OSError:
        pass
    os._exit(0)


def main() -> None:
    result_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)

    raw_input = sys.stdin.read()
    try:
        sys.stdin.close()
    except Exception:
        pass

    payload = json.loads(raw_input)
    code: str = payload.get("code", "")
    test_src: str = payload.get("tests", "")
    per_test_timeout_sec = float(payload.get("per_test_timeout_sec") or 2.0)
    if per_test_timeout_sec <= 0:
        per_test_timeout_sec = 2.0
    max_stdout_bytes = int(payload.get("max_stdout_bytes") or 16 * 1024)
    max_test_stdout_bytes = int(payload.get("max_test_stdout_bytes") or 4 * 1024)

    work_dir = os.environ.get("SANDBOX_WORK_DIR", "/work")
    os.makedirs(work_dir, exist_ok=True)
    solution_path = os.path.join(work_dir, "solution.py")
    solution_real = os.path.realpath(solution_path)
    solution_lines = code.splitlines()
    test_lines = test_src.splitlines()

    with open(solution_path, "w", encoding="utf-8") as fh:
        fh.write(code)

    if work_dir not in sys.path:
        sys.path.insert(0, work_dir)

    # 1. Compile tests strictly in memory (never written to disk).
    try:
        test_code_obj = compile(test_src, "<hidden_test>", "exec")
    except SyntaxError as exc:
        err_line = exc.lineno or 0
        code_line = _get_code_line(test_lines, err_line)
        del test_lines, test_src, raw_input, payload
        _emit_and_exit(
            result_fd,
            {
                "status": "syntax_error",
                "score": 0,
                "ran": 0,
                "passed": 0,
                "failed": 0,
                "total": 0,
                "stdout": "",
                "stdout_truncated": False,
                "duration_ms": 0,
                "tests": [],
                "syntax_error": {
                    "source": "tests",
                    "error_type": type(exc).__name__,
                    "error_message": _truncate_str(str(exc.msg or exc), 512),
                    "line": err_line,
                    "code_line": code_line,
                },
            },
        )
        return

    # Purge raw test source before any student code is compiled or imported.
    del test_lines, test_src, raw_input, payload

    # 2. Pre-compile student solution to catch syntax/indentation errors cleanly.
    try:
        compile(code, solution_path, "exec")
    except SyntaxError as exc:
        err_line = exc.lineno or 0
        _emit_and_exit(
            result_fd,
            {
                "status": "syntax_error",
                "score": 0,
                "ran": 0,
                "passed": 0,
                "failed": 0,
                "total": 0,
                "stdout": "",
                "stdout_truncated": False,
                "duration_ms": 0,
                "tests": [],
                "syntax_error": {
                    "source": "solution",
                    "error_type": type(exc).__name__,
                    "error_message": _truncate_str(str(exc.msg or exc), 512),
                    "line": err_line,
                    "code_line": _get_code_line(solution_lines, err_line),
                },
            },
        )
        return

    del code
    run_start = time.monotonic()
    signal.signal(signal.SIGALRM, _timeout_handler)

    # 3. Import student solution under stdout capture and timeout guard.
    import_capture = _PipeCapture(max_stdout_bytes, devnull_fd)
    import_capture.start()
    try:
        signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)
        import solution  # noqa: F401
    except _TestTimeoutError:
        signal.setitimer(signal.ITIMER_REAL, 0)
        top_stdout, top_trunc = import_capture.stop()
        _emit_and_exit(
            result_fd,
            {
                "status": "timeout",
                "score": 0,
                "ran": 0,
                "passed": 0,
                "failed": 0,
                "total": 0,
                "stdout": top_stdout,
                "stdout_truncated": top_trunc,
                "duration_ms": int((time.monotonic() - run_start) * 1000),
                "tests": [],
                "internal_error": "Importing solution.py exceeded timeout",
            },
        )
        return
    except Exception as exc:
        signal.setitimer(signal.ITIMER_REAL, 0)
        top_stdout, top_trunc = import_capture.stop()
        _emit_and_exit(
            result_fd,
            {
                "status": "runtime_error",
                "score": 0,
                "ran": 0,
                "passed": 0,
                "failed": 0,
                "total": 0,
                "stdout": top_stdout,
                "stdout_truncated": top_trunc,
                "duration_ms": int((time.monotonic() - run_start) * 1000),
                "tests": [],
                "internal_error": (
                    f"{type(exc).__name__}: {_truncate_str(str(exc), 512)}\n"
                    f"{_full_traceback(exc)}"
                ),
            },
        )
        return
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)

    top_stdout, top_trunc = import_capture.stop()
    remaining_stdout_budget = max(0, max_stdout_bytes - len(top_stdout.encode("utf-8")))

    # 4. Execute test module definitions to discover tests.
    current_state: dict[str, object] = {}

    def expect(actual: object, expected: object, inputs: object = None) -> None:
        if inputs is not None:
            current_state["inputs"] = _fmt_inputs(inputs)
        current_state["expected"] = _fmt_value(expected)
        current_state["actual"] = _fmt_value(actual)
        current_state["used_expect"] = True
        if actual != expected:
            raise AssertionError(
                f"expected {_fmt_value(expected)}, got {_fmt_value(actual)}"
            )

    def record_inputs(inputs: object) -> None:
        if inputs is not None:
            current_state["inputs"] = _fmt_inputs(inputs)

    test_ns: dict[str, object] = {
        "__name__": "__hidden_tests__",
        "expect": expect,
        "record_inputs": record_inputs,
    }

    exec_capture = _PipeCapture(min(max_test_stdout_bytes, remaining_stdout_budget), devnull_fd)
    exec_capture.start()
    try:
        signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)
        exec(test_code_obj, test_ns)
    except _TestTimeoutError:
        signal.setitimer(signal.ITIMER_REAL, 0)
        extra_stdout, extra_trunc = exec_capture.stop()
        _emit_and_exit(
            result_fd,
            {
                "status": "timeout",
                "score": 0,
                "ran": 0,
                "passed": 0,
                "failed": 0,
                "total": 0,
                "stdout": top_stdout + extra_stdout,
                "stdout_truncated": top_trunc or extra_trunc,
                "duration_ms": int((time.monotonic() - run_start) * 1000),
                "tests": [],
                "internal_error": "Test module setup exceeded timeout",
            },
        )
        return
    except Exception as exc:
        signal.setitimer(signal.ITIMER_REAL, 0)
        extra_stdout, extra_trunc = exec_capture.stop()
        _emit_and_exit(
            result_fd,
            {
                "status": "runtime_error",
                "score": 0,
                "ran": 0,
                "passed": 0,
                "failed": 0,
                "total": 0,
                "stdout": top_stdout + extra_stdout,
                "stdout_truncated": top_trunc or extra_trunc,
                "duration_ms": int((time.monotonic() - run_start) * 1000),
                "tests": [],
                "internal_error": (
                    f"{type(exc).__name__}: {_truncate_str(str(exc), 512)}\n"
                    f"{_full_traceback(exc)}"
                ),
            },
        )
        return
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)

    extra_stdout, extra_trunc = exec_capture.stop()
    if extra_stdout:
        top_stdout += extra_stdout
        top_trunc = top_trunc or extra_trunc
        remaining_stdout_budget = max(0, max_stdout_bytes - len(top_stdout.encode("utf-8")))

    del test_code_obj

    # Discover top-level test_* callables and unittest.TestCase methods in order.
    discovered: list[tuple[str, object, object]] = []
    for name, obj in test_ns.items():
        if name.startswith("test_") and callable(obj) and not isinstance(obj, type):
            discovered.append((name, obj, obj))
        elif (
            isinstance(obj, type)
            and issubclass(obj, unittest.TestCase)
            and obj is not unittest.TestCase
        ):
            for attr_name, attr_val in obj.__dict__.items():
                if attr_name.startswith("test_") and callable(attr_val):
                    def _make_runner(cls=obj, method_name=attr_name):
                        def _run_case() -> None:
                            inst = cls(methodName=method_name)
                            inst.setUp()
                            try:
                                getattr(inst, method_name)()
                            finally:
                                inst.tearDown()

                        return _run_case

                    discovered.append((attr_name, attr_val, _make_runner()))

    results: list[dict[str, object]] = []
    ran = 0
    passed_count = 0
    failed_count = 0

    # 5. Continue-on-failure execution across all discovered tests.
    for idx, (name, doc_obj, runner_fn) in enumerate(discovered, start=1):
        current_state.clear()
        display_name, has_docstring = _extract_display_name(doc_obj, name)
        hidden = name.startswith("test_hidden_")

        per_cap = min(max_test_stdout_bytes, remaining_stdout_budget)
        test_capture = _PipeCapture(per_cap, devnull_fd)
        test_capture.start()
        t0 = time.monotonic()

        status = "passed"
        passed = True
        error_type = ""
        error_message = ""
        tb_frames: list[dict[str, object]] = []
        detail = ""

        try:
            signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)
            runner_fn()
        except _TestTimeoutError:
            status = "timeout"
            passed = False
            error_type = "TimeoutError"
            error_message = f"Test exceeded {per_test_timeout_sec:g}s time limit"
            detail = error_message
        except BaseException as exc:
            if isinstance(exc, KeyboardInterrupt):
                raise
            status = "failed"
            passed = False
            error_type = type(exc).__name__
            error_message = _truncate_str(str(exc), 512)
            tb_frames = _extract_solution_traceback(exc, solution_real, solution_lines)
            detail = _full_traceback(exc)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            test_stdout, test_trunc = test_capture.stop()

        duration_ms = int((time.monotonic() - t0) * 1000)
        remaining_stdout_budget = max(
            0, remaining_stdout_budget - len(test_stdout.encode("utf-8"))
        )

        ran += 1
        if passed:
            passed_count += 1
        else:
            failed_count += 1

        entry: dict[str, object] = {
            "index": idx,
            "name": name,
            "display_name": display_name,
            "hidden": hidden,
            "status": status,
            "passed": passed,
            "duration_ms": duration_ms,
            "has_docstring": has_docstring,
            "used_expect": bool(current_state.get("used_expect", False)),
        }
        if "inputs" in current_state:
            entry["inputs"] = current_state["inputs"]
        if "expected" in current_state:
            entry["expected"] = current_state["expected"]
        if "actual" in current_state:
            entry["actual"] = current_state["actual"]
        if error_type:
            entry["error_type"] = error_type
        if error_message:
            entry["error_message"] = error_message
        if tb_frames:
            entry["traceback"] = tb_frames
        if test_stdout:
            entry["stdout"] = test_stdout
        if test_trunc:
            entry["stdout_truncated"] = True
        if detail:
            entry["detail"] = detail

        results.append(entry)

    total = len(discovered)
    score = (passed_count * 100) // total if total > 0 else 0
    total_duration_ms = int((time.monotonic() - run_start) * 1000)

    _emit_and_exit(
        result_fd,
        {
            "status": "ok",
            "score": score,
            "ran": ran,
            "passed": passed_count,
            "failed": failed_count,
            "total": total,
            "stdout": top_stdout,
            "stdout_truncated": top_trunc,
            "duration_ms": total_duration_ms,
            "tests": results,
        },
    )


if __name__ == "__main__":
    main()
