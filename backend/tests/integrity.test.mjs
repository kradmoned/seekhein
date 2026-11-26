import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import ts from "typescript"

const root = fileURLToPath(new URL("../", import.meta.url))
function load(relative) {
  const filename = path.resolve(root, relative)
  const exports = {}
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(source, {
    exports, Response, Buffer, TextDecoder,
    require: (name) => load(path.resolve(path.dirname(filename), `${name}.ts`)),
  })
  return exports
}
const { scoreIntegrity } = load("lib/integrity.ts")
const { validateEvents } = load("lib/integrity-events.ts")
const sessionId = "11111111-1111-4111-8111-111111111111"
let sequence = 0
function event(type, payload = {}, time = "2026-11-27T10:00:00.000Z") {
  return { event_id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`, session_id: sessionId, type, payload, received_at: time, client_ts: "1999-01-01T00:00:00.000Z" }
}
function wire(type, payload = {}) {
  const data = event(type, payload)
  return { event_id: data.event_id, session_id: data.session_id, type, payload, ts: data.received_at }
}

test("clean work has no penalty and absent telemetry is identified", () => {
  assert.equal(scoreIntegrity([], null).telemetry_status, "missing")
  const score = scoreIntegrity([event("lab_opened")], null)
  assert.equal(score.score, 100)
  assert.equal(score.flags.length, 0)
  assert.equal(score.telemetry_status, "recorded")
})
test("paste-heavy work is capped and retry events count once", () => {
  const events = Array.from({ length: 8 }, () => event("paste_blocked", { chars: 300 }))
  const score = scoreIntegrity([...events, events[0]], null)
  assert.equal(score.score, 60)
  assert.equal(score.flags.length, 8)
  assert.equal(score.penalties.paste, 40)
})
test("large inserts have their own capped penalty", () => {
  const score = scoreIntegrity(Array.from({ length: 5 }, () => event("large_insert", { chars: 81 })), null)
  assert.equal(score.score, 70)
  assert.match(score.flags[0].evidence, /81 characters/)
})
test("tab switching and blur are combined and have a grace allowance", () => {
  const events = []
  for (let i = 0; i < 8; i++) {
    events.push(event("window_blur"), event("tab_hidden"), event("tab_visible"), event("window_focus"))
  }
  const score = scoreIntegrity(events, null)
  assert.equal(score.focus_losses, 8)
  assert.equal(score.penalties.focus, 20)
  assert.equal(score.flags.filter((f) => f.penalty > 0).length, 4)
})
test("window-only focus changes count and separate pages have independent state", () => {
  const other = event("window_blur")
  other.session_id = "22222222-2222-4222-8222-222222222222"
  const score = scoreIntegrity([event("window_blur"), other, event("window_focus"), event("window_blur")], null)
  assert.equal(score.focus_losses, 3)
  assert.equal(score.penalties.focus, 0)
})
test("fast pass uses first received lab opening and ignores client timestamps", () => {
  const opened = event("lab_opened")
  const reopened = event("lab_opened", {}, "2026-11-27T10:01:00.000Z")
  const score = scoreIntegrity([opened], "2026-11-27T10:00:59.999Z")
  assert.equal(score.score, 80)
  assert.equal(score.flags[0].type, "fast_pass")
  assert.equal(scoreIntegrity([opened], "2026-11-27T10:01:00.000Z").score, 100)
  assert.equal(scoreIntegrity([opened, reopened], "2026-11-27T10:01:10.000Z").score, 100)
  assert.equal(scoreIntegrity([opened], "2026-11-27T09:59:00.000Z").score, 100)
  assert.equal(scoreIntegrity([], "2026-11-27T10:00:10.000Z").score, 100)
})
test("combined penalties floor at zero and preserve the input", () => {
  const events = [event("lab_opened")]
  for (let i = 0; i < 10; i++) events.push(event("paste_blocked", { chars: null }), event("large_insert", { chars: 300 }), event("tab_hidden"), event("tab_visible"))
  const snapshot = JSON.stringify(events)
  const score = scoreIntegrity(events, "2026-11-27T10:00:10.000Z")
  assert.equal(score.score, 0)
  assert.equal(score.penalty, 100)
  assert.equal(score.badge, "red")
  assert.equal(JSON.stringify(events), snapshot)
})
test("unknown event types are dropped and missing payload defaults safely", () => {
  assert.equal(validateEvents([{ type: "future_type" }]).length, 0)
  const input = wire("lab_opened")
  delete input.payload
  assert.equal(JSON.stringify(validateEvents([input])[0].payload), "{}")
  assert.equal(validateEvents([wire("paste_blocked")])[0].payload.chars, null)
})
test("batch validation rejects invalid and forged fields", () => {
  for (const input of [
    {}, Array(101).fill({ type: "future_type" }), [null],
    [{ ...wire("lab_opened"), student_id: sessionId }],
    [{ ...wire("lab_opened"), received_at: "2026-11-27T10:00:00.000Z" }],
    [{ ...wire("lab_opened"), session_id: "bad" }],
    [{ ...wire("lab_opened"), ts: "2026-02-30T10:00:00.000Z" }],
    [wire("paste_blocked", { chars: -1 })], [wire("paste_blocked", { chars: 1.5 })],
    [wire("large_insert", { chars: 80 })], [wire("large_insert")],
    [wire("paste_blocked", { chars: 500, text: "PRIVATE_CLIPBOARD" })],
    [wire("tab_hidden", { chars: 10 })],
  ]) assert.throws(() => validateEvents(input), (error) => error.status === 400)
})
