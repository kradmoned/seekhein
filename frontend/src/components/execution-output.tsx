import type { ReactNode } from 'react'
import { Tabs } from '@base-ui/react/tabs'
import { Button } from '@/components/ui/button'
import type { ExecutionTest, RunResult } from '@/lib/types'

const statusLabels = {
  ok: 'Tests finished', syntax_error: 'Python syntax error', runtime_error: 'Runtime error',
  timeout: 'Execution exceeded its time limit', oom: 'Execution exceeded its memory limit',
}
const testLabels = { passed: 'Passed', failed: 'Failed', timeout: 'Timed out', not_run: 'Not run' }

function OutputText({ children }: { children: string }) {
  // React text nodes escape arbitrary output; preserve whitespace without interpreting HTML.
  return <pre className="min-w-0 whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]">{children}</pre>
}
function Stream({ value, truncated }: { value?: string; truncated?: boolean }) {
  return <>{value !== undefined && value !== '' && <OutputText>{value}</OutputText>}{truncated && <p className="text-xs text-warning">Output truncated by the runner.</p>}</>
}
function Diagnostics({ test }: { test: ExecutionTest }) {
  return <>
    {test.traceback && test.traceback.length > 0 && <OutputText>{`Traceback (student code):\n${test.traceback.map(frame => `  Line ${frame.line}, in ${frame.function}\n    ${frame.code}`).join('\n')}`}</OutputText>}
    {(test.error_type !== undefined || test.error_message !== undefined) && <div className="text-destructive"><OutputText>{[test.error_type, test.error_message].filter(value => value !== undefined).join(': ')}</OutputText></div>}
  </>
}
function CompactTests({ result }: { result: RunResult }) {
  return <ul className="divide-y">{result.results.map((test, index) => <li key={index} className="flex justify-between gap-3 py-2"><span className="break-all">{test.name}</span><span className={test.passed ? 'text-success' : 'text-destructive'}>{test.passed ? 'Passed' : test.error ?? 'Failed'}</span></li>)}</ul>
}

export function ExecutionOutput({ result, children, stale = false, busy = false, onClear }: {
  result: RunResult | null; children?: ReactNode; stale?: boolean; busy?: boolean; onClear?: () => void
}) {
  const detailed = result && 'tests' in result ? result : null
  const allPassed = result?.status === 'ok' && result.total > 0 && result.passed === result.total
  const tabClass = 'border-b-2 border-transparent px-3 py-3 text-sm text-muted-foreground outline-none data-[active]:border-primary data-[active]:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
  return <Tabs.Root defaultValue="console" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card" aria-label="Execution results">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 border-b bg-muted/40 px-2">
      <Tabs.List aria-label="Output views" className="flex"><Tabs.Tab className={tabClass} value="console">Console</Tabs.Tab><Tabs.Tab className={tabClass} value="tests">Tests</Tabs.Tab></Tabs.List>
      <div className="flex items-center gap-2">{result && <span className="text-xs tabular-nums text-muted-foreground">{result.passed}/{result.total} passed{detailed && ` · ${detailed.duration_ms} ms`}</span>}{onClear && <Button size="sm" variant="ghost" disabled={!result} onClick={onClear}>Clear output</Button>}</div>
    </header>
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-sm" tabIndex={0} aria-label="Execution output">
      {children}
      {result && <>
        <p role="status" className={allPassed ? 'font-medium text-success' : 'font-medium'}><span>{allPassed ? 'All tests passed' : result.status === 'ok' ? `${result.total - result.passed} of ${result.total} tests did not pass` : statusLabels[result.status]}</span><span className="ml-2 font-normal text-muted-foreground">Score {result.score}%</span></p>
        {stale && <p className="text-xs text-muted-foreground">These results belong to an earlier code snapshot. Run again to check your changes.</p>}
      </>}
      <Tabs.Panel value="console" className="space-y-3 outline-none">
        {!result && !busy && <p className="text-muted-foreground">Run your code to see output and errors.</p>}
        {result && !detailed && <><p className="text-muted-foreground">Detailed output isn’t available for this submission.</p><CompactTests result={result} /></>}
        {detailed && <>
          {(detailed.stdout !== '' || detailed.stdout_truncated) && <section className="space-y-2"><h3 className="font-medium">Setup output</h3><Stream value={detailed.stdout} truncated={detailed.stdout_truncated} /></section>}
          {detailed.syntax_error && <section className="space-y-2 text-destructive"><h3 className="font-medium">Syntax error · line {detailed.syntax_error.line}</h3><OutputText>{[detailed.syntax_error.code_line, [detailed.syntax_error.error_type, detailed.syntax_error.error_message].filter(value => value !== undefined).join(': ')].filter(value => value !== undefined).join('\n')}</OutputText></section>}
          {detailed.tests.filter(test => test.stdout || test.stdout_truncated || test.error_type !== undefined || test.error_message !== undefined || test.traceback?.length || !test.passed).map((test, i) => <section key={i} className="space-y-2 border-t pt-3"><h3 className="break-words font-medium">{test.display_name} <span className="font-normal text-muted-foreground">· {testLabels[test.status]}</span></h3><Stream value={test.stdout} truncated={test.stdout_truncated} /><Diagnostics test={test} />{!test.passed && test.error_type === undefined && test.error_message === undefined && !test.traceback?.length && <p className="text-muted-foreground">No additional error details were returned.</p>}</section>)}
          {!detailed.stdout && !detailed.stdout_truncated && !detailed.syntax_error && detailed.tests.every(test => test.passed && !test.stdout && !test.stdout_truncated && test.error_type === undefined && test.error_message === undefined && !test.traceback?.length) && <p className="text-muted-foreground">{detailed.status === 'ok' ? 'No console output was captured.' : 'No additional error details or console output were returned.'}</p>}
        </>}
      </Tabs.Panel>
      <Tabs.Panel value="tests" className="space-y-2 outline-none">
        {!result && !busy && <p className="text-muted-foreground">Run your code to see test outcomes.</p>}
        {result && !detailed && <CompactTests result={result} />}
        {result && result.total === 0 && <p className="text-muted-foreground">No individual test outcomes were returned. Check Console for diagnostics.</p>}
        {detailed?.tests.map((test, i) => <details key={i} open={!test.passed} className="border-b pb-2">
          <summary className="cursor-pointer break-words py-2 focus-visible:outline-ring"><span className="font-medium">{test.display_name}</span><span className={test.passed ? 'ml-2 text-success' : 'ml-2 text-destructive'}>{testLabels[test.status]}</span><span className="ml-2 text-xs text-muted-foreground">{test.duration_ms} ms</span></summary>
          <div className="space-y-2">{(['inputs', 'expected', 'actual'] as const).map(field => test[field] !== undefined && <div key={field} className="space-y-1"><h4 className="text-xs font-medium">{{ inputs: 'Inputs', expected: 'Expected', actual: 'Actual' }[field]}</h4><OutputText>{test[field]}</OutputText></div>)}<Diagnostics test={test} /><Stream value={test.stdout} truncated={test.stdout_truncated} /></div>
        </details>)}
      </Tabs.Panel>
    </div>
  </Tabs.Root>
}
