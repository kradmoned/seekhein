#!/usr/bin/env python3
"""In-container unittest.TestCase execution harness for Seekkhein Python labs."""

import contextlib
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


def _fmt_subtest_params(params: dict[str, object], limit: int = 300) -> str:
    if not params:
        return ""
    parts = [f"{k}={repr(v)}" for k, v in params.items()]
    return _truncate_str(", ".join(parts), limit)


def _humanize_name(name: str) -> str:
    stripped = name
    if stripped.startswith("test_"):
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


def _discover_test_classes(test_ns: dict[str, object]) -> list[tuple[type, list[tuple[str, object]]]]:
    classes: list[tuple[type, list[tuple[str, object]]]] = []
    seen_cls: set[int] = set()
    for obj in test_ns.values():
        if (
            isinstance(obj, type)
            and issubclass(obj, unittest.TestCase)
            and obj is not unittest.TestCase
            and id(obj) not in seen_cls
        ):
            seen_cls.add(id(obj))
            methods: list[tuple[str, object]] = []
            seen_methods: set[str] = set()
            for base in obj.__mro__:
                if base is unittest.TestCase or base is object:
                    break
                for attr_name, attr_val in base.__dict__.items():
                    if (
                        attr_name.startswith("test_")
                        and callable(attr_val)
                        and attr_name not in seen_methods
                    ):
                        seen_methods.add(attr_name)
                        methods.append((attr_name, attr_val))
            if methods:
                classes.append((obj, methods))
    return classes


_EQUALITY_ASSERT_METHODS = (
    "assertEqual",
    "assertAlmostEqual",
    "assertListEqual",
    "assertDictEqual",
    "assertSetEqual",
    "assertTupleEqual",
    "assertCountEqual",
)


def _bind_assertion_wrappers(
    inst: unittest.TestCase, state_getter
) -> None:
    depth = 0

    for method_name in _EQUALITY_ASSERT_METHODS:
        orig = getattr(unittest.TestCase, method_name, None)
        if orig is None:
            continue

        def _make_wrapper(orig_fn):
            def _wrapped(*args, **kwargs):
                nonlocal depth
                if depth == 0:
                    state = state_getter()
                    first = args[0] if len(args) >= 1 else kwargs.get("first")
                    second = args[1] if len(args) >= 2 else kwargs.get("second")
                    if len(args) >= 2 or ("first" in kwargs and "second" in kwargs):
                        state["actual"] = _fmt_value(first)
                        state["expected"] = _fmt_value(second)
                depth += 1
                try:
                    return orig_fn(inst, *args, **kwargs)
                finally:
                    depth -= 1

            return _wrapped

        setattr(inst, method_name, _make_wrapper(orig))


def _build_entry(
    idx: int,
    name: str,
    display_name: str,
    has_docstring: bool,
    status: str,
    passed: bool,
    duration_ms: int,
    state: dict[str, object],
    stdout: str,
    stdout_trunc: bool,
    error_type: str = "",
    error_message: str = "",
    tb_frames: list[dict[str, object]] | None = None,
    detail: str = "",
) -> dict[str, object]:
    entry: dict[str, object] = {
        "index": idx,
        "name": name,
        "display_name": display_name,
        "status": status,
        "passed": passed,
        "duration_ms": duration_ms,
        "has_docstring": has_docstring,
    }
    if "inputs" in state and state["inputs"]:
        entry["inputs"] = state["inputs"]
    if "expected" in state:
        entry["expected"] = state["expected"]
    if "actual" in state:
        entry["actual"] = state["actual"]
    if error_type:
        entry["error_type"] = error_type
    if error_message:
        entry["error_message"] = error_message
    if tb_frames:
        entry["traceback"] = tb_frames
    if stdout:
        entry["stdout"] = stdout
    if stdout_trunc:
        entry["stdout_truncated"] = True
    if detail:
        entry["detail"] = detail
    return entry


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
        test_code_obj = compile(test_src, "<test_suite>", "exec")
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

    # 4. Execute test module definitions and discover unittest.TestCase subclasses.
    test_ns: dict[str, object] = {"__name__": "__lab_tests__"}
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

    discovered_classes = _discover_test_classes(test_ns)
    raw_entries: list[dict[str, object]] = []

    # 5. Execute each unittest.TestCase class with full lifecycle & subTest expansion.
    for cls, methods in discovered_classes:
        setup_cls_cap = _PipeCapture(min(max_test_stdout_bytes, remaining_stdout_budget), devnull_fd)
        setup_cls_cap.start()
        setup_cls_err: BaseException | None = None
        setup_cls_timeout = False
        try:
            signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)
            cls.setUpClass()
        except _TestTimeoutError as exc:
            setup_cls_timeout = True
            setup_cls_err = exc
        except BaseException as exc:
            if isinstance(exc, KeyboardInterrupt):
                raise
            setup_cls_err = exc
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            cls_stdout, cls_trunc = setup_cls_cap.stop()

        if cls_stdout:
            top_stdout += cls_stdout
            top_trunc = top_trunc or cls_trunc
            remaining_stdout_budget = max(0, max_stdout_bytes - len(top_stdout.encode("utf-8")))

        if setup_cls_err is not None:
            err_type = "TimeoutError" if setup_cls_timeout else type(setup_cls_err).__name__
            err_msg = (
                f"setUpClass exceeded {per_test_timeout_sec:g}s time limit"
                if setup_cls_timeout
                else _truncate_str(str(setup_cls_err), 512)
            )
            tb_frames = [] if setup_cls_timeout else _extract_solution_traceback(setup_cls_err, solution_real, solution_lines)
            detail = err_msg if setup_cls_timeout else _full_traceback(setup_cls_err)
            status = "timeout" if setup_cls_timeout else "failed"
            for attr_name, attr_val in methods:
                display_name, has_docstring = _extract_display_name(attr_val, attr_name)
                raw_entries.append(
                    _build_entry(
                        idx=0,
                        name=attr_name,
                        display_name=display_name,
                        has_docstring=has_docstring,
                        status=status,
                        passed=False,
                        duration_ms=0,
                        state={},
                        stdout="",
                        stdout_trunc=False,
                        error_type=err_type,
                        error_message=err_msg,
                        tb_frames=tb_frames,
                        detail=detail,
                    )
                )
            continue

        try:
            for attr_name, attr_val in methods:
                method_display_name, has_docstring = _extract_display_name(attr_val, attr_name)
                inst = cls(methodName=attr_name)

                outer_state: dict[str, object] = {}
                active_state: dict[str, object] = outer_state
                subtest_records: list[dict[str, object]] = []

                per_cap = min(max_test_stdout_bytes, remaining_stdout_budget)
                active_capture = _PipeCapture(per_cap, devnull_fd)
                outer_stdout_chunks: list[str] = []
                outer_trunc = False

                def _drain_active_to_outer() -> None:
                    nonlocal remaining_stdout_budget, outer_trunc
                    text, trunc = active_capture.stop()
                    if text:
                        outer_stdout_chunks.append(text)
                        remaining_stdout_budget = max(
                            0, remaining_stdout_budget - len(text.encode("utf-8"))
                        )
                    if trunc:
                        outer_trunc = True

                _bind_assertion_wrappers(inst, lambda: active_state)

                @contextlib.contextmanager
                def _subtest(msg=unittest.case._subtest_msg_sentinel, **params):
                    nonlocal active_state, active_capture, remaining_stdout_budget
                    _drain_active_to_outer()

                    sub_msg = ""
                    if msg is not unittest.case._subtest_msg_sentinel and msg is not None:
                        sub_msg = _truncate_str(str(msg), 120)

                    sub_state: dict[str, object] = {}
                    formatted_inputs = _fmt_subtest_params(params)
                    if formatted_inputs:
                        sub_state["inputs"] = formatted_inputs

                    prev_state = active_state
                    active_state = sub_state

                    sub_cap = _PipeCapture(
                        min(max_test_stdout_bytes, remaining_stdout_budget), devnull_fd
                    )
                    sub_cap.start()
                    st_t0 = time.monotonic()
                    st_status = "passed"
                    st_passed = True
                    st_err_type = ""
                    st_err_msg = ""
                    st_frames: list[dict[str, object]] = []
                    st_detail = ""

                    try:
                        signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)
                        yield
                    except _TestTimeoutError:
                        st_status = "timeout"
                        st_passed = False
                        st_err_type = "TimeoutError"
                        st_err_msg = f"Test exceeded {per_test_timeout_sec:g}s time limit"
                        st_detail = st_err_msg
                    except BaseException as exc:
                        if isinstance(exc, KeyboardInterrupt):
                            raise
                        st_status = "failed"
                        st_passed = False
                        st_err_type = type(exc).__name__
                        st_err_msg = _truncate_str(str(exc), 512)
                        st_frames = _extract_solution_traceback(exc, solution_real, solution_lines)
                        st_detail = _full_traceback(exc)
                    finally:
                        signal.setitimer(signal.ITIMER_REAL, 0)
                        st_stdout, st_trunc = sub_cap.stop()
                        st_dur = int((time.monotonic() - st_t0) * 1000)
                        remaining_stdout_budget = max(
                            0, remaining_stdout_budget - len(st_stdout.encode("utf-8"))
                        )
                        subtest_records.append(
                            {
                                "msg": sub_msg,
                                "status": st_status,
                                "passed": st_passed,
                                "duration_ms": st_dur,
                                "state": sub_state,
                                "stdout": st_stdout,
                                "stdout_trunc": st_trunc,
                                "error_type": st_err_type,
                                "error_message": st_err_msg,
                                "tb_frames": st_frames,
                                "detail": st_detail,
                            }
                        )
                        active_state = prev_state
                        next_cap = _PipeCapture(
                            min(max_test_stdout_bytes, remaining_stdout_budget), devnull_fd
                        )
                        next_cap.start()
                        active_capture = next_cap
                        signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)

                inst.subTest = _subtest  # type: ignore[method-assign]

                active_capture.start()
                t0 = time.monotonic()

                outer_status = "passed"
                outer_passed = True
                outer_err_type = ""
                outer_err_msg = ""
                outer_frames: list[dict[str, object]] = []
                outer_detail = ""
                setup_ok = False

                try:
                    signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)
                    inst.setUp()
                    setup_ok = True
                    getattr(inst, attr_name)()
                except _TestTimeoutError:
                    outer_status = "timeout"
                    outer_passed = False
                    outer_err_type = "TimeoutError"
                    outer_err_msg = f"Test exceeded {per_test_timeout_sec:g}s time limit"
                    outer_detail = outer_err_msg
                except BaseException as exc:
                    if isinstance(exc, KeyboardInterrupt):
                        raise
                    outer_status = "failed"
                    outer_passed = False
                    outer_err_type = type(exc).__name__
                    outer_err_msg = _truncate_str(str(exc), 512)
                    outer_frames = _extract_solution_traceback(exc, solution_real, solution_lines)
                    outer_detail = _full_traceback(exc)
                finally:
                    if setup_ok:
                        try:
                            signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)
                            inst.tearDown()
                        except _TestTimeoutError:
                            if outer_passed:
                                outer_status = "timeout"
                                outer_passed = False
                                outer_err_type = "TimeoutError"
                                outer_err_msg = f"tearDown exceeded {per_test_timeout_sec:g}s time limit"
                                outer_detail = outer_err_msg
                        except BaseException as exc:
                            if isinstance(exc, KeyboardInterrupt):
                                raise
                            if outer_passed:
                                outer_status = "failed"
                                outer_passed = False
                                outer_err_type = type(exc).__name__
                                outer_err_msg = _truncate_str(str(exc), 512)
                                outer_frames = _extract_solution_traceback(exc, solution_real, solution_lines)
                                outer_detail = _full_traceback(exc)
                    try:
                        signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)
                        inst.doCleanups()
                    except _TestTimeoutError:
                        if outer_passed:
                            outer_status = "timeout"
                            outer_passed = False
                            outer_err_type = "TimeoutError"
                            outer_err_msg = f"Cleanup exceeded {per_test_timeout_sec:g}s time limit"
                            outer_detail = outer_err_msg
                    except BaseException as exc:
                        if isinstance(exc, KeyboardInterrupt):
                            raise
                        if outer_passed:
                            outer_status = "failed"
                            outer_passed = False
                            outer_err_type = type(exc).__name__
                            outer_err_msg = _truncate_str(str(exc), 512)
                            outer_frames = _extract_solution_traceback(exc, solution_real, solution_lines)
                            outer_detail = _full_traceback(exc)
                    finally:
                        signal.setitimer(signal.ITIMER_REAL, 0)
                        _drain_active_to_outer()

                outer_dur = int((time.monotonic() - t0) * 1000)
                outer_stdout = _truncate_str("".join(outer_stdout_chunks), max_test_stdout_bytes)

                if not subtest_records:
                    raw_entries.append(
                        _build_entry(
                            idx=0,
                            name=attr_name,
                            display_name=method_display_name,
                            has_docstring=has_docstring,
                            status=outer_status,
                            passed=outer_passed,
                            duration_ms=outer_dur,
                            state=outer_state,
                            stdout=outer_stdout,
                            stdout_trunc=outer_trunc,
                            error_type=outer_err_type,
                            error_message=outer_err_msg,
                            tb_frames=outer_frames,
                            detail=outer_detail,
                        )
                    )
                elif len(subtest_records) == 1 and outer_passed:
                    sub = subtest_records[0]
                    disp = sub["msg"] or method_display_name
                    if outer_stdout:
                        combined_out = _truncate_str(outer_stdout + sub["stdout"], max_test_stdout_bytes)
                        combined_trunc = outer_trunc or sub["stdout_trunc"]
                    else:
                        combined_out = sub["stdout"]
                        combined_trunc = sub["stdout_trunc"]
                    raw_entries.append(
                        _build_entry(
                            idx=0,
                            name=attr_name,
                            display_name=disp,
                            has_docstring=has_docstring or bool(sub["msg"]),
                            status=sub["status"],
                            passed=sub["passed"],
                            duration_ms=sub["duration_ms"] or outer_dur,
                            state=sub["state"],
                            stdout=combined_out,
                            stdout_trunc=combined_trunc,
                            error_type=sub["error_type"],
                            error_message=sub["error_message"],
                            tb_frames=sub["tb_frames"],
                            detail=sub["detail"],
                        )
                    )
                else:
                    total_sub = len(subtest_records)
                    for sub_idx, sub in enumerate(subtest_records, start=1):
                        if sub["msg"]:
                            disp = sub["msg"]
                        elif has_docstring:
                            disp = f"{method_display_name} (case {sub_idx}/{total_sub})"
                        else:
                            disp = f"{method_display_name} (case {sub_idx}/{total_sub})"
                        raw_entries.append(
                            _build_entry(
                                idx=0,
                                name=f"{attr_name}[{sub_idx}]",
                                display_name=disp,
                                has_docstring=has_docstring or bool(sub["msg"]),
                                status=sub["status"],
                                passed=sub["passed"],
                                duration_ms=sub["duration_ms"],
                                state=sub["state"],
                                stdout=sub["stdout"],
                                stdout_trunc=sub["stdout_trunc"],
                                error_type=sub["error_type"],
                                error_message=sub["error_message"],
                                tb_frames=sub["tb_frames"],
                                detail=sub["detail"],
                            )
                        )
                    if not outer_passed:
                        raw_entries.append(
                            _build_entry(
                                idx=0,
                                name=attr_name,
                                display_name=method_display_name,
                                has_docstring=has_docstring,
                                status=outer_status,
                                passed=False,
                                duration_ms=outer_dur,
                                state=outer_state,
                                stdout=outer_stdout,
                                stdout_trunc=outer_trunc,
                                error_type=outer_err_type,
                                error_message=outer_err_msg,
                                tb_frames=outer_frames,
                                detail=outer_detail,
                            )
                        )
        finally:
            teardown_cls_cap = _PipeCapture(min(max_test_stdout_bytes, remaining_stdout_budget), devnull_fd)
            teardown_cls_cap.start()
            td_err: BaseException | None = None
            td_timeout = False
            try:
                signal.setitimer(signal.ITIMER_REAL, per_test_timeout_sec)
                cls.tearDownClass()
            except _TestTimeoutError as exc:
                td_timeout = True
                td_err = exc
            except BaseException as exc:
                if isinstance(exc, KeyboardInterrupt):
                    raise
                td_err = exc
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
                td_stdout, td_trunc = teardown_cls_cap.stop()

            if td_stdout:
                top_stdout += td_stdout
                top_trunc = top_trunc or td_trunc
                remaining_stdout_budget = max(0, max_stdout_bytes - len(top_stdout.encode("utf-8")))

            if td_err is not None:
                raw_entries.append(
                    _build_entry(
                        idx=0,
                        name=f"{cls.__name__}.tearDownClass",
                        display_name=f"{cls.__name__} class teardown",
                        has_docstring=True,
                        status="timeout" if td_timeout else "failed",
                        passed=False,
                        duration_ms=0,
                        state={},
                        stdout="",
                        stdout_trunc=False,
                        error_type="TimeoutError" if td_timeout else type(td_err).__name__,
                        error_message=(
                            f"tearDownClass exceeded {per_test_timeout_sec:g}s time limit"
                            if td_timeout
                            else _truncate_str(str(td_err), 512)
                        ),
                        tb_frames=[] if td_timeout else _extract_solution_traceback(td_err, solution_real, solution_lines),
                        detail="" if td_timeout else _full_traceback(td_err),
                    )
                )

    passed_count = 0
    failed_count = 0
    for idx, entry in enumerate(raw_entries, start=1):
        entry["index"] = idx
        if entry["passed"]:
            passed_count += 1
        else:
            failed_count += 1

    total = len(raw_entries)
    score = (passed_count * 100) // total if total > 0 else 0
    total_duration_ms = int((time.monotonic() - run_start) * 1000)

    _emit_and_exit(
        result_fd,
        {
            "status": "ok",
            "score": score,
            "ran": total,
            "passed": passed_count,
            "failed": failed_count,
            "total": total,
            "stdout": top_stdout,
            "stdout_truncated": top_trunc,
            "duration_ms": total_duration_ms,
            "tests": raw_entries,
        },
    )


if __name__ == "__main__":
    main()
