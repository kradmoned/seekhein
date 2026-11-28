import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"
import ts from "typescript"

// Exercise the exact reference adapter shipped to the frontend team.
const guide = readFileSync(new URL("../docs/frontend-integrity.md", import.meta.url), "utf8")
const source = guide.match(/```ts\n(import type \* as Monaco[\s\S]*?)\n```/)[1]
const exports = {}
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports })

function harness() {
  let value = "starter\n"
  const listeners = new Set()
  const events = []
  const accepted = []
  const warnings = []
  const wrapper = new EventTarget()
  const model = {
    getValue: () => value,
    validatePosition: (position) => position,
    onDidChangeContent(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) } },
    setValue(next) {
      value = next
      for (const listener of listeners) listener({ changes: [{ text: next }], isUndoing: false, isRedoing: false })
    },
  }
  const editor = { getModel: () => model, updateOptions() {}, getPosition: () => ({ lineNumber: 1, column: 1 }), setPosition() {} }
  const guard = exports.installIntegrityGuard(editor, wrapper, 80, (type, payload) => events.push({ type, payload }), (message) => warnings.push(message), (code) => accepted.push(code))
  function dispatch(type, fields = {}) {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, fields)
    wrapper.dispatchEvent(event)
    return event
  }
  return { model, events, accepted, warnings, guard, dispatch, listeners }
}

test("documented guard accepts the threshold and restores code after bulk input", () => {
  const h = harness()
  h.model.setValue("a".repeat(80))
  assert.equal(h.events.length, 0)
  assert.equal(h.accepted.length, 1)
  h.model.setValue("b".repeat(81))
  assert.equal(h.guard.getAcceptedCode(), "a".repeat(80))
  assert.equal(h.model.getValue(), "a".repeat(80))
  assert.equal(h.accepted.length, 1)
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].type, "large_insert")
  assert.equal(h.events[0].payload.chars, 81)
})
test("paste shortcuts and clipboard/drop events are canceled and recorded", () => {
  const h = harness()
  assert.equal(h.dispatch("keydown", { key: "v", ctrlKey: true }).defaultPrevented, true)
  assert.equal(h.dispatch("keydown", { key: "v", metaKey: true }).defaultPrevented, true)
  assert.equal(h.dispatch("keydown", { key: "Insert", shiftKey: true }).defaultPrevented, true)
  h.dispatch("keydown", { key: "v", ctrlKey: true, repeat: true })
  assert.equal(h.events.length, 3)
  assert.equal(h.dispatch("paste", { clipboardData: { getData: () => "code" } }).defaultPrevented, true)
  assert.equal(h.dispatch("drop", { dataTransfer: { getData: () => "12345" } }).defaultPrevented, true)
  assert.equal(h.events.length, 5)
  assert.equal(h.events[3].payload.chars, 4)
  assert.equal(h.events[4].payload.chars, 5)
  assert.equal(h.guard.getAcceptedCode(), "starter\n")
  assert.equal(h.dispatch("keydown", { key: "c", ctrlKey: true }).defaultPrevented, false)
})
test("disposing the documented guard removes its listeners", () => {
  const h = harness()
  h.guard.dispose()
  assert.equal(h.listeners.size, 0)
  assert.equal(h.dispatch("paste").defaultPrevented, false)
  assert.equal(h.events.length, 0)
})
