# Frontend integration for lab integrity

This handoff targets the Vite/React/TypeScript application and Monaco editor.
The backend implements event validation, access control, storage, penalties,
submission recording, and reports. The frontend implements immediate editor
restrictions, activity collection, reliable delivery, and report rendering.

Final submission and practice execution have separate workflows. Follow
[frontend-final-submissions.md](frontend-final-submissions.md) for the required
submission-limit control, Submit action, retry recovery, accepted-code digest,
and teacher code inspection. Lab details return `max_submissions` and the
compatibility field `allow_resubmissions`.

## Backend contract

Use the existing authenticated API client. All requests carry
`Authorization: Bearer <Supabase access token>`. Refresh expired tokens through
the existing login/session flow. Keep requests on the frontend's existing API
proxy or gateway. The backend does not introduce cross-origin configuration.

`GET /api/labs/{id}` now includes `integrity_policy` alongside the existing lab
fields. Read these values when mounting the editor. The current policy is

```json
{
  "version": "2026-11-27",
  "block_paste": true,
  "block_drop": true,
  "block_large_insert": true,
  "large_insert_threshold": 80,
  "flush_interval_ms": 5000,
  "max_batch_items": 100,
  "max_batch_bytes": 65536,
  "paste_penalty": 10,
  "paste_cap": 40,
  "large_insert_penalty": 15,
  "large_insert_cap": 30,
  "focus_grace": 3,
  "focus_penalty": 5,
  "focus_cap": 20,
  "fast_pass_seconds": 60,
  "fast_pass_penalty": 20
}
```

Apply collection to enrolled students. Teacher preview uses the existing run
endpoint and produces no student submission. Posting telemetry as a teacher
returns `403`.

`POST /api/labs/{id}/events` accepts an array of up to 100 events and 65,536
UTF-8 bytes. A successful response is `204` with an empty body.

```json
[
  {
    "event_id": "2d588df5-a769-4624-b339-9ea2b68d4594",
    "session_id": "f28fbaf6-a002-416d-980f-06d198002031",
    "type": "paste_blocked",
    "payload": { "chars": 340 },
    "ts": "2026-11-27T14:02:11.000Z"
  }
]
```

- Generate `event_id` using `crypto.randomUUID()` once when observing the action.
  Retain that ID on every retry. The first accepted event wins.
- Generate `session_id` once for each mounted lab page. Keep it for that page's
  events. It identifies a browser page for focus grouping. It is client-supplied.
- Use `new Date().toISOString()` for `ts`. It is optional and may be `null`.
  Scoring and timelines use server `received_at` timestamps.
- Identity comes from authentication. The server rejects extra identity, score,
  timestamp, or other undocumented fields.
- Payload defaults to `{}`. Extra payload fields are rejected. Clipboard text,
  editor code, and chat text belong outside telemetry.
- Unknown event types are silently dropped. Invalid known events reject the
  entire batch. An empty array succeeds for an accessible lab.

| Event | Payload | Collect when |
| --- | --- | --- |
| `lab_opened` | `{}` | The lab and editor are ready. Send this first and flush immediately. |
| `paste_blocked` | `{ "chars": number or null }` | A paste shortcut, clipboard paste, or drop is blocked. Use `null` when the size is unavailable. |
| `large_insert` | `{ "chars": number }` | An editor change inserts more than 80 UTF-16 code units and is reverted. |
| `tab_hidden` | `{}` | `document.visibilityState` becomes `hidden`. |
| `tab_visible` | `{}` | The document becomes visible again. |
| `window_blur` | `{}` | The browser window loses focus. |
| `window_focus` | `{}` | The window regains focus. This completes focus-loss episodes. |
| `run` | `{}` | Optional observation of a Run click. The server records processed execution separately. |
| `chat_sent` | `{}` | Optional observation once tutor messaging exists. |

Character counts must be safe integers from 0 to 10,000,000. `large_insert`
requires a count greater than the policy threshold. A paste shortcut may be
blocked before clipboard data is available, so `null` is valid for that event.

| HTTP status | Frontend action |
| --- | --- |
| `204` | Remove the acknowledged events from the queue. Do not parse JSON. |
| `400` | Show a telemetry delivery error and inspect the invalid batch or size. Preserve it for diagnosis. |
| `401` | Refresh authentication, then retry the same events. |
| `403` | Stop collection for this role and refresh user state. |
| `404` | Stop sending for this lab and refresh course access. |
| `415` | Fix the request's JSON content type. |
| `500` or network failure | Retain the batch and retry with backoff. |

## Editor restrictions

Strict mode blocks all pastes, including text copied within the editor, and all
drops into the editor. Ordinary selection, copying, and typing remain available.
Use an inline warning or accessible live region instead of a modal alert. A
modal can itself produce focus changes.

Intercept paste and drop events on the editor wrapper in the capture phase.
Handle Ctrl/Cmd+V and Shift+Insert there as well, because editor keybindings can
perform paste independently of the normal DOM path. Scope the listeners to the
editor wrapper so forms and the rest of the page stay usable.

Monaco's content-change callback runs after the model changes. The fallback
below restores the accepted value synchronously when it detects bulk input.
Use `getAcceptedCode()` for Run and `onAcceptedChange` for app state. Install this
guard before other code-change subscribers and give it responsibility for
publishing accepted editor state. [Monaco editor API](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ICodeEditor.html)

This reference uses `setValue` to remove a rejected bulk change. That resets
Monaco's undo history when a bulk change is rejected. Normal typing and accepted
undo/redo retain their usual behavior. Initial code loading happens before the
guard is installed. [Monaco text-model API](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ITextModel.html)

```ts
import type * as Monaco from "monaco-editor"

type Emit = (
  type: "paste_blocked" | "large_insert",
  payload: { chars: number | null },
) => void

export function installIntegrityGuard(
  editor: Monaco.editor.IStandaloneCodeEditor,
  wrapper: HTMLElement,
  threshold: number,
  emit: Emit,
  warn: (message: string) => void,
  onAcceptedChange: (code: string) => void,
) {
  const model = editor.getModel()
  if (!model) throw new Error("Mount the editor model before the integrity guard")
  let accepted = model.getValue()
  let restoring = false

  editor.updateOptions({
    contextmenu: false,
    dragAndDrop: false,
    formatOnPaste: false,
    formatOnType: false,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    acceptSuggestionOnEnter: "off",
    tabCompletion: "off",
    snippetSuggestions: "none",
    inlineSuggest: { enabled: false },
  })

  function block(event: Event, chars: number | null) {
    event.preventDefault()
    event.stopImmediatePropagation()
    emit("paste_blocked", { chars })
    warn("Pasting and dropping text are disabled for this lab.")
  }
  function paste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData("text/plain")
    block(event, text === undefined ? null : text.length)
  }
  function drop(event: DragEvent) {
    const text = event.dataTransfer?.getData("text/plain")
    block(event, text === undefined ? null : text.length)
  }
  function dragOver(event: DragEvent) { event.preventDefault() }
  function keyDown(event: KeyboardEvent) {
    const pasteKey = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v"
    const alternatePaste = event.shiftKey && event.key === "Insert"
    if (pasteKey || alternatePaste) {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.repeat) {
        emit("paste_blocked", { chars: null })
        warn("Pasting is disabled for this lab.")
      }
    }
  }

  wrapper.addEventListener("paste", paste, { capture: true })
  wrapper.addEventListener("drop", drop, { capture: true })
  wrapper.addEventListener("dragover", dragOver, { capture: true })
  wrapper.addEventListener("keydown", keyDown, { capture: true })
  const change = model.onDidChangeContent((event) => {
    if (restoring) return
    const inserted = event.changes.reduce((sum, edit) => sum + edit.text.length, 0)
    if (inserted > threshold && !event.isUndoing && !event.isRedoing) {
      const position = editor.getPosition()
      restoring = true
      try {
        model.setValue(accepted)
        if (position) editor.setPosition(model.validatePosition(position))
      } finally {
        restoring = false
      }
      emit("large_insert", { chars: inserted })
      warn(`Changes inserting more than ${threshold} characters at once are disabled.`)
      return
    }
    accepted = model.getValue()
    onAcceptedChange(accepted)
  })

  return {
    getAcceptedCode: () => accepted,
    dispose() {
      change.dispose()
      wrapper.removeEventListener("paste", paste, { capture: true })
      wrapper.removeEventListener("drop", drop, { capture: true })
      wrapper.removeEventListener("dragover", dragOver, { capture: true })
      wrapper.removeEventListener("keydown", keyDown, { capture: true })
    },
  }
}
```

The blocked shortcut prevents the corresponding paste from reaching Monaco.
Emit one event for the intercepted action. A bulk fallback should run only when
an actual model change occurred. Test that one paste cannot generate both a
paste penalty and a large-insert penalty in each supported browser.

The strict bulk rule also affects large snippets and composition input. Verify
the target input languages and accessibility workflow before using it for an
assessed lab. Keep editor commands that intentionally replace many characters
out of strict mode's UI. Dispose and reinstall the guard when switching models.

## Telemetry hook and delivery

Implement `useTelemetry(labId, studentId, getAccessToken)` with the following
contract. This portion is an implementation checklist for the frontend owner.

1. Maintain a queue of complete event objects. Persist queued objects locally
   under the authenticated user and lab, including their original session and
   event IDs. Surface a delivery warning if storage is unavailable or full.
2. Create a new session ID for a mounted page. Emit `lab_opened` once when ready,
   then emit current visibility/focus state if the page starts hidden or blurred.
3. Subscribe to `visibilitychange`, window `blur`, and window `focus`. Preserve
   callback order in the queue. React Strict Mode setup/cleanup must leave one
   active subscription and timer. Dispose everything on lab/user changes.
4. Flush immediately after `lab_opened`, then every five seconds. Request an
   immediate flush after a hidden event and on page departure.
5. Send one batch at a time per page. Take the oldest queued items, up to 100.
   Measure `new TextEncoder().encode(JSON.stringify(batch)).byteLength` and
   shrink the batch until it fits. Use a smaller 60 KiB ceiling for keepalive
   delivery to leave space within browser transport limits.
6. Fetch a current access token for each send. Use authenticated `fetch`, JSON,
   and `keepalive: true` for departure delivery. `sendBeacon` cannot set the
   required bearer header. Delivery at page shutdown is best effort.
7. On `204`, remove exactly the acknowledged event IDs from persisted storage.
   Merge with any events added while the request was in flight. Retain IDs on
   retry. Back off after network/server failures. Avoid overlapping flushes.
8. Keep queued events after navigation, reload, and temporary authentication
   failure. Replay them only when the same user returns. Scope queues by user
   so logging in as another account cannot submit a previous user's telemetry.
9. Before Run, await an attempted queue flush, then call the normal run route
   with `guard.getAcceptedCode()`. Show delivery status when telemetry remains
   queued. Preserve usable editor state during a network failure.

Avoid collecting every keystroke. The queue carries restricted actions and
visibility/focus transitions. Backend scoring supplies the report's penalties.

Example send logic for an already selected batch is

```ts
const response = await fetch(`/api/labs/${labId}/events`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${await getAccessToken()}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(batch),
  keepalive: true,
})
if (response.status === 204) {
  acknowledge(batch.map((event) => event.event_id))
}
```

## Teacher report

Poll `GET /api/labs/{id}/report` every ten seconds while the report is visible.
Use one request at a time, abort on navigation, and stop polling on `401`, `403`,
or `404` until authentication/access is refreshed. Only the course owner can
read this endpoint.

The response shape is

```ts
type LabReport = {
  lab_id: string
  title: string
  allow_resubmissions: boolean
  max_submissions: number | null
  integrity_policy: Record<string, unknown>
  chat_available: false
  students: Array<{
    student_id: string
    email: string
    full_name: string | null
    enrolled: boolean
    first_pass_at: string | null
    accepted_submission_count: number
    remaining_submissions: number | null
    events: Array<{
      event_id: string
      session_id: string
      type: string
      payload: { chars?: number | null }
      client_ts: string | null
      received_at: string
    }>
    submissions: Array<{
      id: string
      kind: "practice" | "final"
      version: number | null
      code_sha256: string | null
      results: Array<{ name: string; passed: boolean; error: string | null }>
      status: string
      score: number
      passed: number
      total: number
      created_at: string
    }>
    integrity: {
      score: number
      penalty: number
      penalties: { paste: number; large_insert: number; focus: number; fast_pass: number }
      badge: "green" | "amber" | "red"
      flags: Array<{ type: string; evidence: string; at: string; penalty: number }>
      focus_losses: number
      telemetry_status: "recorded" | "missing_lab_opened" | "missing"
    }
  }>
}
```

Students arrive sorted by integrity score ascending with a stable student-ID
tie-breaker. Render their name, result summary, score, flags, and expandable
timeline. Use `received_at` for event ordering and display. Flags already carry
human-readable evidence and the actual deduction after caps. Zero-penalty
flags remain visible for the grace allowance and actions beyond a penalty cap.

Show a neutral **Telemetry incomplete** label when `telemetry_status` is missing
or missing the opening event. A score of 100 with missing telemetry should
not be presented as evidence of observed clean activity. Display event text
using React text nodes. The report contains no clipboard contents or hidden
test source. `chat_available` remains false for this teacher report: student
assistant chats are stored separately and are not exposed through this endpoint.

Each student also receives `practice_attempt_count`, `accepted_submission`, and
`integrity_scope: "current_lab"`. The accepted-submission shape is specified in
the final-submission guide. Filter attempts using `kind` when presenting practice
counts or final versions. Integrity remains current across both attempt kinds.

Overlapping `window_blur` and `tab_hidden` events count as a single departure
until both visibility and focus return. Each page session tracks its own state.
The first three departures are free, then five points are deducted per extra
departure up to twenty. Paste penalties cap at forty, and bulk penalties cap
at thirty. A server-recorded perfect run within sixty seconds of the first
received opening event deducts twenty. Overall score floors at zero.

The fast-pass calculation is an observation affected by delayed telemetry
delivery. It uses the first recorded opening across sessions, so reloading the
page does not reset it. Events retain browser-claimed timestamps for reference.
The score is intended to support teacher review and student explanations.

## End-to-end acceptance checks

- Enroll two students. Student A's blocked actions appear only under A. Student
  B cannot post events for an unenrolled course or read the report.
- Verify Ctrl+V, Cmd+V, Shift+Insert, browser-menu paste, and drag/drop. Each
  blocked action leaves accepted code intact and produces one event.
- Insert 80 characters in a single model change, then 81. The second change
  must be reverted and recorded. Check multiselection changes, undo/redo,
  snippets, IME input, and editor initialization separately.
- Switch tabs four times. Include blur/hidden/visible/focus events and verify
  four departures with a five-point focus penalty.
- Retry the identical event batch twice. Verify the timeline and penalties
  remain unchanged after the first successful delivery.
- Disconnect and reconnect, refresh authentication, navigate away and return,
  and exercise React Strict Mode. Check queue replay and single listeners.
- Run a passing solution. Verify the report receives its server-recorded result
  and time. A teacher preview must create no student submission.
- Open the report as another teacher. Expect `404`. Open as a student. Expect
  `403`. Verify the correct teacher sees updates within the polling interval.

The backend tests cover the APIs, scoring, access checks, and database behavior.
The editor adapter and browser lifecycle checks require execution in the actual
frontend application. Browser code and telemetry can be modified or suppressed
by a student controlling their client.
