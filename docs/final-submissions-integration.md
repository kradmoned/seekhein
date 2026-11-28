# Final submissions and integrity integration

The frontend implements the supplied final-submission/limit contract and the
integrity handoff in the adjacent backend's `docs/frontend-integrity.md`.

## User workflows

- Teachers choose 1, 2, 3, or Unlimited accepted versions when uploading a lab.
  Existing numeric policies are preserved in the edit control, including limits
  above 3. The lab workspace provides an owner-only PATCH control.
- Students use Run for practice and Submit for a final. Status loads alongside
  lab details. Accepted versions, server timestamps, test scores, remaining
  allowance, and comparison with the current editor are shown separately.
- Final actions persist an exact source snapshot and UUID before any request.
  Each action uses a separate local-storage key scoped to user and lab. New
  actions are paused while unresolved actions exist. Recovery remains available
  when the limit is exhausted and never replaces the saved code with editor text.
- Processing responses retry the same request twice with exponential backoff and
  Retry-After. Further retries are explicit recovery actions. Authentication gets
  one refresh/retry. Service failures, malformed responses, and uncertain delivery
  retain recovery data. Terminal validation/limit responses remove only that key.
- Teachers open course-student reports from the roster, inspect accepted code,
  and open the lab report for earlier versions and activity timelines. Lab
  reports poll every ten seconds while visible and stop on access errors.

## Integrity behavior

Student editor restrictions follow `integrity_policy` from the lab response.
Paste keyboard shortcuts, clipboard events, and drops are intercepted on the
editor wrapper only. Bulk inserts above the policy threshold are synchronously
reverted. Accepted edits alone update drafts, Run, and Submit. Normal undo/redo
remain available; rejecting bulk input resets Monaco undo history.

Opening, blocked paste/drop, rejected large inserts, visibility, focus, and Run
observations enter a per-event durable queue. IDs and page session IDs survive
retries. Separate event keys avoid cross-tab queue replacement. Teachers neither
collect events nor receive student editor restrictions. Telemetry never contains
code or clipboard contents.

Delivery is serialized per mounted page, byte/count bounded, periodically retried
with backoff, and attempted before Run/Submit. Each attempt has a five-second
network deadline so an unavailable telemetry service does not indefinitely block
execution. Page departure uses authenticated keepalive requests; browser shutdown
delivery remains best effort. Account checks prevent a departing page from sending
one user's queue under another user's token.

Reports distinguish verified test scores from Current lab integrity score and
show telemetry completeness. Flags describe observed behavior, not proof of
cheating. Browser controls and telemetry cannot prevent a determined client from
bypassing them.

## Backend rollout dependency

No application database migrations were applied by this frontend task. The local
backend checkout inspected during implementation contains course and integrity
migrations, but not the final-submission/limit migrations or their implementation
handoff. The backend deployment must apply these once, in order:

1. `20261126_001_courses.sql`
2. `20261127_001_integrity.sql`
3. `20261127_002_final_submissions.sql`
4. `20261127_003_submission_limits.sql`

Lab details must include `max_submissions`, `allow_resubmissions`, and
`integrity_policy`. Final submission, status, policy update, reports, and accepted
source endpoints must be deployed together. Invalid response shapes produce an
error rather than falsely reporting acceptance or silently disabling integrity.

## Verification

Use Node 22.18+ (Node 26 was used during development):

```sh
npm ci
npm test
npm run build
npm run test:browser
```

Browser tests use installed Google Chrome and mocked Supabase/API responses with
real Monaco assets served from the installed package. They need no real accounts
or database. They exercise editor restrictions, telemetry, uploads, final recovery,
processing retries, storage failures, failed attempts, and teacher source views.
Live ownership, enrollment, database concurrency, scoring, and migration outcomes
still require the backend integration suite and a deployed-account smoke test.

Verification performed during this change:

- Production TypeScript/Vite build passed.
- All three unit-test files passed (12 tests in total).
- Sixteen Chrome browser scenarios passed against mocked API responses, including
  the compact submission popover, resizing, responsive layouts, theme switching,
  and contrast checks.
- New and changed feature files passed targeted ESLint checks. Repository-wide
  lint still reports seven pre-existing errors in auth/template/UI code.
- No live database migration, production deployment, or backend concurrency test
  was performed by this frontend change.

## Workspace layout

Run and the Submit/details button group live in the editor toolbar. The three-dot
popover contains accepted counts, maximum/remaining allowance, the latest accepted
version and digest comparison, errors/retry controls, and pending recovery actions.
Submission outcome messages and a compact attention/recovery link remain visible
in the output pane when the popover is closed.

On desktop, instructions and the workspace have a horizontal resize divider; the
editor and output have a vertical divider on all screen sizes. Dividers support
pointer/touch dragging, arrow keys (Shift for larger steps), Home/End, and Enter or
double-click to reset. Resizing preserves the editor model, drafts, and telemetry
session. Narrow screens stack instructions above the editor/output workspace.

### Detailed runner output (2026-11-28)

Run, final submission responses, and submitted-code inspection now use a shared Console/Tests viewer. It renders root and per-test stdout separately, syntax diagnostics, student traceback frames, truncation notices, and expandable test inputs/expected/actual values. All output is rendered as React text, never HTML. The response parser validates detailed fields while retaining compact historical execution support. Clearing output changes only the local view; it does not clear accepted submissions or pending recovery actions.

Backend deployment must apply `20261128_001_runner_output.sql` after the existing migrations. This frontend change does not apply database migrations or verify the live runner. Browser checks use mocked responses, including null characters, HTML-like output, missing diagnostics, and historical records.

### Updated saved-final semantics and upload validation

The current UI uses **Maximum submissions**: both passing finals and unfinished work saved with Submit anyway use a slot. Rejected ordinary submissions do not. Submit anyway is available in submission details and is surfaced beside Submit after an unsuccessful execution; the detail view explains slot consumption before sending. Saved results are labeled tests passed or pending teacher review; test score is automatic, not a teacher grade. Teacher lists include a pending-review filter, and final timeline entries derive their label from execution status and passed/total.

Pending records now include `submit_anyway`; older records default to false. Every retry sends the same UUID, exact code and original mode. Changing mode creates a new action. Historical responses without review metadata remain supported; partial or malformed new metadata is rejected before clearing pending actions.

Uploads validate UTF-8, nonempty source and null characters, with 1 MiB instructions and 64 KiB Python files. The backend validates and saves in one request. Success displays server validation time and warnings with an Open saved lab link. Invalid-lab diagnostics render as escaped text while selected files remain in the form. Service failures allow manual retry, with a delay for 429; uncertain network/500 outcomes require checking course labs before re-enabling retry because upload has no idempotency key.

Deployment still requires `20261127_004_lab_validation.sql`, `20261128_001_runner_output.sql`, and `20261128_002_submit_anyway.sql` after the earlier migrations. No application database migrations were applied or verified by this frontend task. Browser fixtures validate frontend behavior, not the deployed backend or live runner.
