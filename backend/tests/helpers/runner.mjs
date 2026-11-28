// A test-only runner envelope. Production receives both views from one run.
export function bothViews(student) {
  return { student, tutor: {
    status: student?.status, score: student?.score, ran: student?.ran, passed: student?.passed,
    failed: student?.failed, total: student?.total, duration_ms: student?.duration_ms,
    passed_tests: (student?.tests ?? []).filter((t) => t.passed).map((t) => t.name),
    failures: (student?.tests ?? []).filter((t) => !t.passed).map((t) => ({ ...t, detail: 'PRIVATE_TUTOR_TRACEBACK' })),
    top_level_stdout: student?.stdout,
    ...(student?.syntax_error ? { syntax_error: { ...student.syntax_error, source: 'solution' } } : {}),
    internal_error: 'PRIVATE_TUTOR_DETAIL',
  } }
}
