import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import Markdown from 'react-markdown'
import { api } from '@/lib/api'
import { labDetail } from '@/lib/integrity'
import type { LabDetail } from '@/lib/types'
import { Button, buttonVariants } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { ContentSkeleton } from '@/components/loading-state'
import { EditSubmissionLimit } from '@/components/submission-limit'

export function TeacherLabOverview({ id, courseId, labPath }: { id: string; courseId?: string; labPath: string }) {
  const [lab, setLab] = useState<LabDetail | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<unknown>(`/api/labs/${encodeURIComponent(id)}`, { signal: controller.signal }).then(value => {
      const detail = labDetail(value)
      if (!controller.signal.aborted) setLab(detail)
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to load lab.') })
    return () => controller.abort()
  }, [id, attempt])
  return <section className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
    <Link className="text-sm text-muted-foreground underline" to={courseId ? `/courses/${courseId}` : '/courses'}>Back to {courseId ? 'course' : 'courses'}</Link>
    {error ? <Notice tone="error" title="Lab could not be loaded" actions={<Button size="sm" variant="outline" onClick={() => { setError(''); setAttempt(value => value + 1) }}>Retry lab</Button>}>{error}</Notice> : !lab && <ContentSkeleton />}
    {lab && <>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5"><div><p className="mb-2 text-sm text-muted-foreground">Lab management</p><h1 className="text-2xl font-semibold">{lab.title}</h1><p className="mt-2 text-sm text-muted-foreground">Review student work and manage how this lab is submitted.</p></div><div className="flex flex-wrap gap-2"><Link className={buttonVariants({ variant: 'outline' })} to={`${labPath}?view=preview`}>Preview &amp; test</Link><Link className={buttonVariants()} to={`/labs/${id}/report`}>Submissions &amp; reports</Link></div></header>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="min-w-0 space-y-4"><section className="overflow-hidden rounded-xl border bg-card"><h2 className="border-b px-5 py-4 font-medium">Student instructions</h2><article aria-label="Student instructions" className="lab-markdown p-5"><Markdown skipHtml>{lab.instructions}</Markdown></article></section>
          <details className="rounded-xl border bg-card p-5"><summary className="cursor-pointer font-medium">Starter code</summary><p className="mt-3 text-xs text-muted-foreground">The starting code provided to students.</p><pre tabIndex={0} aria-label="Read-only starter code" className="mt-3 max-h-80 overflow-auto rounded-lg bg-muted/50 p-4 font-mono text-xs leading-5">{lab.starter}</pre></details>
        </div>
        <aside className="space-y-4" aria-label="Lab settings">{lab.validation && <section className="space-y-2 rounded-xl border bg-card p-5"><h2 className="font-medium">Reference validation</h2><p className="text-sm">{lab.validation.passed_tests}/{lab.validation.total_tests} supplied tests passed</p>{lab.validated_at && <p className="text-xs text-muted-foreground">{new Date(lab.validated_at).toLocaleString()}</p>}{lab.validation.warnings.length > 0 && <ul className="list-disc pl-4 text-xs text-muted-foreground">{lab.validation.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}</section>}{lab.validation === null && <p className="text-sm text-muted-foreground">This existing lab has no stored reference-validation record.</p>}<section className="space-y-3 rounded-xl border bg-card p-5"><h2 className="font-medium">Submission policy</h2><EditSubmissionLimit labId={id} initial={lab.max_submissions} /></section>
          <section className="space-y-3 rounded-xl border bg-card p-5"><h2 className="font-medium">Student integrity policy</h2><ul className="list-disc space-y-2 pl-4 text-sm text-muted-foreground"><li>{lab.integrity_policy.block_paste ? 'External pastes are blocked; copying within the lab editor is allowed.' : 'Pasting is allowed.'}</li><li>{lab.integrity_policy.block_drop ? 'Text drops are blocked.' : 'Text drops are allowed.'}</li>{lab.integrity_policy.block_large_insert && <li>Bulk insertions above {lab.integrity_policy.large_insert_threshold} characters are blocked, except approved internal pastes.</li>}<li>Student focus changes and activity are recorded for review.</li></ul><p className="border-t pt-3 text-xs text-muted-foreground">Teacher previews are unrestricted and do not send student integrity events.</p></section>
        </aside>
      </div>
    </>}
  </section>
}
