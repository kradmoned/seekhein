import type { LabValidation } from '@/lib/lab-validation'
export function UploadDiagnostics({ value }: { value: LabValidation }) {
  const pre = 'whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs [overflow-wrap:anywhere]'
  return <section aria-label="Reference validation diagnostics" className="space-y-3 rounded-xl border bg-card p-4 text-sm"><h2 className="font-medium">Reference validation failed</h2><p>{value.summary}</p><p>{value.passed_tests}/{value.total_tests} tests passed · {value.status}</p>
    {value.syntax_error && <div><h3 className="font-medium">{value.syntax_error.source === 'tests' ? 'tests.py' : 'solution.py'} · line {value.syntax_error.line}</h3><pre className={pre}>{[value.syntax_error.code_line, value.syntax_error.error_type, value.syntax_error.error_message].filter(item => item !== undefined).join('\n')}</pre></div>}
    {value.stdout && <pre className={pre}>{value.stdout}</pre>}
    {value.tests.map((test, index) => <details key={index} open={!test.passed} className="space-y-2 border-t pt-2"><summary className="cursor-pointer font-medium">{test.display_name} · {test.status}</summary>{(['inputs', 'expected', 'actual', 'error_type', 'error_message', 'full_traceback', 'stdout'] as const).map(field => test[field] !== undefined && <div key={field}><h4 className="text-xs text-muted-foreground">{field.replaceAll('_', ' ')}</h4><pre className={pre}>{test[field]}</pre></div>)}</details>)}
    {value.warnings.length > 0 && <ul className="list-disc pl-4">{value.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
  </section>
}
