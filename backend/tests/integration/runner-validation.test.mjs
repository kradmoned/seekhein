import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import ts from "typescript"

// Explicit smoke test against the configured runner. Uses only synthetic source
// and creates no labs or database records. Requires the runner's Docker service.
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

test("live runner validates teacher labs through the production adapter", { skip: !process.env.RUNNER_URL }, async (t) => {
  const { validateLab } = load("lib/lab-validation.ts")
  const tests = 'import unittest\nfrom solution import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        """Adds two numbers"""\n        self.assertEqual(add(2, 3), 5)\n'
  for (const [name, solution, suite, valid, status] of [
    ["passing reference", "def add(a,b): return a+b\n", tests, true, "ok"],
    ["failing reference", "def add(a,b): return a-b\n", tests, false, "ok"],
    ["no discovered tests", "pass\n", "def test_top_level(): pass\n", false, "ok"],
    ["solution syntax error", "def add(a,b)\n    return a+b\n", tests, false, "syntax_error"],
    ["test syntax error", "def add(a,b): return a+b\n", "def invalid(\n", false, "syntax_error"],
  ]) {
    await t.test(name, async () => {
      const result = await validateLab(solution, suite)
      assert.equal(result.valid, valid)
      assert.equal(result.status, status)
      if (valid) assert.ok(result.total_tests > 0 && result.passed_tests === result.total_tests)
    })
  }
})
