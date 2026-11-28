import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
export function loader({ modules = {}, globals = {} } = {}) {
  const cache = new Map()
  function load(relative) {
    const filename = path.resolve(root, relative)
    const name = path.relative(root, filename)
    if (name in modules) return modules[name]
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}; cache.set(filename, exports)
    const source = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
    vm.runInNewContext(source, {
      Request, Response, URL, Buffer, TextDecoder, AbortSignal, process, fetch,
      console: { error() {} }, ...globals, exports,
      require: (dependency) => dependency.startsWith('.') ? load(path.resolve(path.dirname(filename), `${dependency}.ts`)) : require(dependency),
    }, { filename })
    return exports
  }
  return load
}
