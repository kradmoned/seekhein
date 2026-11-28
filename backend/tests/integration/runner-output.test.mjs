import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import ts from "typescript"

const root = fileURLToPath(new URL("../../", import.meta.url))
function load(relative, cache = new Map()) {
  const filename = path.resolve(root, relative)
  if (cache.has(filename)) return cache.get(filename)
  const exports = {}; cache.set(filename, exports)
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(source, {
    exports, URL, Buffer, TextDecoder, AbortSignal, fetch, process,
    require: (name) => load(path.resolve(path.dirname(filename), `${name}.ts`), cache),
  }, { filename })
  return exports
}

// Synthetic code only; creates no application database records.
test("live runner exposes console output, test diagnostics and syntax locations", { skip: !process.env.RUNNER_URL }, async () => {
  const { runCode } = load("lib/runner.ts")
  const tests = 'import unittest\nfrom solution import divide\nclass T(unittest.TestCase):\n    def test_basic(self):\n        """Divides numbers"""\n        self.assertEqual(divide(6,2),3)\n    def test_zero(self):\n        """Handles zero"""\n        self.assertEqual(divide(6,0),0)\n'
  const result = await runCode('print("module ready")\ndef divide(a,b):\n    print("dividing", a, b)\n    return a/b\n', tests)
  assert.equal(result.status, "ok")
  assert.equal(result.passed, 1)
  assert.equal(result.total, 2)
  assert.match(result.stdout, /module ready/)
  const failed = result.tests.find((item) => !item.passed)
  assert.equal(failed.error_type, "ZeroDivisionError")
  assert.match(failed.error_message, /division by zero/)
  assert.ok(failed.traceback.some((frame) => frame.function === "divide"))
  assert.match(failed.stdout, /dividing 6 0/)
  const syntax = await runCode("def divide(a,b)\n    return a/b\n", tests)
  assert.equal(syntax.status, "syntax_error")
  assert.equal(syntax.syntax_error.line, 1)
  assert.equal(syntax.syntax_error.code_line, "def divide(a,b)")
})
