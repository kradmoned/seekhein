import { Tabs } from '@base-ui/react/tabs'
import { Input } from '@/components/ui/input'
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import type { LabReport } from '@/lib/submission-contract'
import { ExecutionOutput } from "@/components/execution-output"
import { Notice } from "@/components/ui/notice"
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { api, ApiError } from '@/lib/api'
import { studentReport, submittedCode, labReport, reviewLabel, type IntegritySummary, type AcceptedSubmission } from '@/lib/submission-contract'
import { Button, buttonVariants } from '@/components/ui/button'
import { LoadingStatus } from '@/components/loading-state'

function useReport<T>(path: string, parse: (value: unknown) => T, poll = false) {
  const [data, setData] = useState<{ path: string; value: T } | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    async function load() {
      let stop = false
      try {
        const value = parse(await api<unknown>(path, { signal: controller.signal }))
        if (!controller.signal.aborted) { setData({ path, value }); setError('') }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to load report.')
        stop = error instanceof ApiError && [401, 403, 404].includes(error.status)
      } finally {
        if (poll && !stop && !controller.signal.aborted) timer = window.setTimeout(() => { if (!document.hidden) void load(); else timer = window.setTimeout(loadWhenVisible, 1000) }, 10_000)
      }
    }
    function loadWhenVisible() { if (!document.hidden) void load(); else timer = window.setTimeout(loadWhenVisible, 1000) }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [path, parse, attempt, poll])
  return { data: data?.path === path ? data.value : null, error, retry: () => { setError(''); setAttempt(value => value + 1) } }
}
function ReportState({ error, retry }: { error: string; retry: () => void }) {
  return error ? <Notice tone="error" title="Report could not be loaded" actions={<Button variant="outline" size="sm" onClick={retry}>Retry report</Button>}>{error}</Notice> : <LoadingStatus>Loading report…</LoadingStatus>
}
export function IntegrityDetails({ value }: { value: IntegritySummary }) {
  return <div className="space-y-2 text-sm"><p className="font-medium">Current lab integrity score: {value.score}/100 · {value.badge}</p><p>Telemetry: {value.telemetry_status === 'recorded' ? 'Opening event recorded; delivery may still be incomplete' : `Telemetry incomplete (${value.telemetry_status.replaceAll('_', ' ')})`}</p><p>{value.focus_losses} focus departures · Deductions: paste {value.penalties.paste}, large insert {value.penalties.large_insert}, focus {value.penalties.focus}, fast pass {value.penalties.fast_pass}</p><p className="text-muted-foreground">Observed activity supports review; it is not proof of cheating. This score reflects current lab activity, not a submission-time snapshot.</p>{value.flags.length > 0 && <details><summary className="cursor-pointer">Activity flags ({value.flags.length})</summary><ul className="max-h-64 space-y-2 overflow-y-auto pt-2">{value.flags.map((flag, i) => <li key={i}>{new Date(flag.at).toLocaleString()} · {flag.evidence} · −{flag.penalty}</li>)}</ul></details>}</div>
}
function Accepted({ value }: { value: AcceptedSubmission | null }) {
  const location = useLocation()
  return value ? <div className="space-y-1"><p>Saved version {value.version} · {new Date(value.submitted_at).toLocaleString()}</p><p className="font-medium">{reviewLabel(value)}</p><p>Test score: {value.execution.score}% · {value.execution.passed}/{value.execution.total} passed</p><Link className="text-sm underline" to={`/submissions/${value.submission_id}`} state={{ returnTo: location.pathname + location.search }}>View submitted code</Link></div> : <p className="text-muted-foreground">No saved submission submission.</p>
}
export function StudentReportPage() {
  const { courseId = '', studentId = '' } = useParams()
  const { data, error, retry } = useReport(`/api/courses/${encodeURIComponent(courseId)}/students/${encodeURIComponent(studentId)}/report`, studentReport)
  return <section className="mx-auto max-w-5xl space-y-6 p-6"><Link className="text-sm underline" to={`/courses/${courseId}`}>Back to course</Link><h1 className="text-2xl font-semibold">Student course report</h1>{(!data || error) && <ReportState error={error} retry={retry} />}{data && <><h2 className="text-xl">{data.student.full_name || data.student.email}</h2><Button variant="outline" onClick={retry}>Refresh report</Button>{data.labs.length === 0 && <p>No labs or recorded activity in this course.</p>}{data.labs.map(lab => <article key={lab.lab_id} className="space-y-4 rounded-xl border bg-card p-5"><h3 className="text-lg font-semibold">{lab.title}</h3><p className="text-sm">{lab.practice_attempt_count} practice attempts · {lab.accepted_submission_count} saved submissions · {lab.remaining_submissions === null ? 'Unlimited remaining' : `${lab.remaining_submissions} remaining`} (limit: {lab.max_submissions ?? 'Unlimited'})</p><Accepted value={lab.accepted_submission} /><IntegrityDetails value={lab.integrity} /><Link className="inline-block text-sm underline" to={`/labs/${lab.lab_id}/report`}>View lab timeline and earlier versions</Link></article>)}</>}</section>
}
export function SubmittedCodePage() {
  const { submissionId = '' } = useParams()
  const location = useLocation()
  const candidate = location.state?.returnTo
  const returnTo = typeof candidate === 'string' && /^\/(?:labs\/[^/?#]+\/report|courses\/[^/?#]+\/students\/[^/?#]+\/report)(?:\?[^#]*)?$/.test(candidate) ? candidate : null
  const { data, error, retry } = useReport(`/api/submissions/${encodeURIComponent(submissionId)}`, submittedCode)
  return <section className="mx-auto max-w-6xl space-y-5 p-6"><header className="sticky top-0 z-10 -mx-6 flex flex-wrap items-center gap-4 border-b bg-background px-6 py-3"><Link className={buttonVariants({ variant: 'outline' })} to={returnTo ?? (data ? `/labs/${data.lab_id}/report` : '/courses')}>← Back to {returnTo?.startsWith('/courses/') ? 'student report' : data || returnTo ? 'lab report' : 'courses'}</Link><h1 className="text-2xl font-semibold">Submitted code</h1></header>{(!data || error) && <ReportState error={error} retry={retry} />}{data && <><p className="font-medium">{reviewLabel(data)}</p><p>Version {data.version} · {new Date(data.submitted_at).toLocaleString()}</p><p className="break-all font-mono text-xs">SHA-256: {data.code_sha256}</p><textarea aria-label="Read-only submitted Python code" readOnly value={data.code} spellCheck={false} className="min-h-96 w-full whitespace-pre rounded-lg border bg-card p-4 font-mono text-sm" /><h2 className="font-semibold">Verified test results</h2><div className="h-96"><ExecutionOutput result={data.execution} /></div></>}</section>
}
export function LabReportPage() {
  const { id = '' } = useParams()
  return <LabReportView key={id} id={id} />
}
function LabReportView({ id }: { id: string }) {
  const { data, error, retry } = useReport(`/api/labs/${encodeURIComponent(id)}/report`, labReport, true)
  return <section className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
    <Link className="text-sm underline" to={`/labs/${id}`}>Back to lab</Link>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{data?.title || 'Lab'} — activity and submissions</h1><p className="mt-2 text-sm text-muted-foreground">Review a student to see their submissions and current lab activity.</p></div><Button variant="outline" size="sm" onClick={retry}>Refresh report</Button></header>
    {(!data || error) && <ReportState error={error} retry={retry} />}
    {data && <LabStudentList data={data} />}
  </section>
}
function PageControls({ page, pages, onChange }: { page: number; pages: number; onChange: (value: number) => void }) {
  return <div className="flex items-center gap-3"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => onChange(page - 1)}>Previous</Button><span className="text-xs tabular-nums text-muted-foreground">Page {page + 1} of {pages}</span><Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}>Next</Button></div>
}
function pageIndex(value: string | null) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}
function PagedItems<T>({ items, render, empty, pageKey }: { items: T[]; render: (item: T) => ReactNode; empty: string; pageKey: string }) {
  const [params, setParams] = useSearchParams()
  const requested = pageIndex(params.get(pageKey))
  function setPage(page: number) { setParams(previous => { const next = new URLSearchParams(previous); next.set(pageKey, String(page)); return next }, { replace: true }) }
  const pages = Math.max(1, Math.ceil(items.length / 10)), page = Math.min(requested, pages - 1)
  return <div className="space-y-4">{items.length ? <ul className="divide-y">{items.slice(page * 10, page * 10 + 10).map((item, i) => <li key={page * 10 + i} className="py-3 text-sm">{render(item)}</li>)}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>}{pages > 1 && <PageControls page={page} pages={pages} onChange={setPage} />}</div>
}
function LabStudentList({ data }: { data: LabReport }) {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const filter = params.get('filter') ?? 'all'
  const requested = pageIndex(params.get('page'))
  const selectedId = params.get('student')
  function update(values: Record<string, string | null>) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      for (const [key, value] of Object.entries(values)) { if (value === null || value === '') next.delete(key); else next.set(key, value) }
      return next
    }, { replace: true })
  }
  function setPage(page: number) { update({ page: String(page) }) }
  const matches = data.students.filter(student => {
    const nameMatch = `${student.full_name ?? ''} ${student.email}`.toLowerCase().includes(query.toLowerCase().trim())
    return nameMatch && (filter === 'all' || filter === 'submitted' && !!student.accepted_submission || filter === 'pending' && !student.accepted_submission || filter === 'review' && student.accepted_submission?.submission_status === 'pending_review' || filter === 'flags' && student.integrity.flags.length > 0 || filter === 'missing' && student.integrity.telemetry_status !== 'recorded')
  }).sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email) || a.student_id.localeCompare(b.student_id))
  const pages = Math.max(1, Math.ceil(matches.length / 10)), page = Math.min(requested, pages - 1)
  const selected = data.students.find(student => student.student_id === selectedId)
  const submitted = data.students.filter(student => student.accepted_submission).length
  return <Sheet open={!!selectedId} onOpenChange={open => { if (!open) update({ student: null, tab: null, historyPage: null, activityPage: null }) }}>
    <div className="flex flex-wrap gap-x-6 gap-y-2 border-y py-3 text-sm text-muted-foreground"><span><strong className="font-medium text-foreground">{data.students.length}</strong> students</span><span><strong className="font-medium text-foreground">{submitted}</strong> with saved submissions</span><span><strong className="font-medium text-foreground">{data.students.length - submitted}</strong> without saved submissions</span><span>Maximum submissions: {data.max_submissions ?? 'Unlimited'}</span></div>
    <div className="flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1 basis-64 space-y-2 text-sm font-medium">Search students<Input type="search" placeholder="Name or email" value={query} onChange={event => { update({ q: event.target.value, page: null }) }} /></label><label className="space-y-2 text-sm font-medium">Show<select className="block h-10 rounded-lg border border-input bg-card px-3 font-normal focus-visible:outline-ring" value={filter} onChange={event => { update({ filter: event.target.value, page: null }) }}><option value="all">All students</option><option value="submitted">Saved submission</option><option value="pending">No saved submission</option><option value="review">Pending teacher review</option><option value="flags">Activity flags</option><option value="missing">Incomplete telemetry</option></select></label></div>
    <section aria-label="Student report list" className="overflow-hidden rounded-xl border bg-card">
      <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-4 border-b bg-muted/40 px-4 py-3 text-xs font-medium text-muted-foreground md:grid"><span>Student</span><span>Latest final</span><span>Practice runs</span><span>Current lab integrity</span><span className="w-20">Details</span></div>
      {!matches.length && <p className="p-8 text-center text-sm text-muted-foreground">{data.students.length ? 'No students match these filters.' : 'No student activity yet.'}</p>}
      <ul className="max-h-[50dvh] divide-y overflow-y-auto">{matches.slice(page * 10, page * 10 + 10).map(student => <li key={student.student_id} className="grid grid-cols-2 items-center gap-3 p-4 text-sm md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] md:gap-4">
        <div className="col-span-2 min-w-0 md:col-span-1"><p className="break-words font-medium">{student.full_name || student.email}</p>{student.full_name && <p className="break-all text-xs text-muted-foreground">{student.email}</p>}{!student.enrolled && <span className="text-xs text-muted-foreground">Historical student</span>}</div>
        <div><span className="block text-xs text-muted-foreground md:hidden">Latest final</span>{student.accepted_submission ? <><span>Version {student.accepted_submission.version}</span><span className="block text-xs">{reviewLabel(student.accepted_submission)}</span><span className="block text-xs text-muted-foreground">Test score {student.accepted_submission.execution.score}%</span></> : <span className="text-muted-foreground">Not submitted</span>}</div>
        <div className="tabular-nums"><span className="block text-xs text-muted-foreground md:hidden">Practice runs</span>{student.practice_attempt_count}</div>
        <div><span className="block text-xs text-muted-foreground md:hidden">Current lab integrity</span><span className={student.integrity.badge === 'red' ? 'text-destructive' : student.integrity.badge === 'amber' ? 'text-warning' : 'text-success'}>{student.integrity.score}/100</span><span className="block text-xs text-muted-foreground">{student.integrity.telemetry_status === 'recorded' ? 'Opening event recorded' : 'Telemetry incomplete'}{student.integrity.flags.length > 0 && ` · ${student.integrity.flags.length} flags`}</span></div>
        <SheetTrigger render={<Button size="sm" variant="outline" className="w-20 justify-self-end" aria-label={`Review ${student.full_name || student.email}`} />} onClick={() => update({ student: student.student_id, tab: null, historyPage: null, activityPage: null })}>Review</SheetTrigger>
      </li>)}</ul>
    </section>
    <footer className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground" role="status">{matches.length ? `${page * 10 + 1}–${Math.min(page * 10 + 10, matches.length)} of ${matches.length} students` : '0 students'}</p><PageControls page={page} pages={pages} onChange={setPage} /></footer>
    <p className="text-xs text-muted-foreground">Updates every ten seconds while visible. Activity flags support review; they are not proof of cheating.</p>
    <SheetContent side="right" className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
      <SheetHeader className="shrink-0 border-b pr-14"><SheetTitle>{selected?.full_name || selected?.email || 'Student details'}</SheetTitle><SheetDescription className="break-all">{selected ? `${selected.email} · ${data.title}` : 'This student is no longer included in the report.'}</SheetDescription></SheetHeader>
      {selected && <StudentLabDetails key={selected.student_id} student={selected} />}
    </SheetContent>
  </Sheet>
}
function StudentLabDetails({ student }: { student: LabReport['students'][number] }) {
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const tab = ['overview', 'submissions', 'activity'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'overview'
  const tabClass = 'border-b-2 border-transparent px-4 py-3 text-sm text-muted-foreground data-[active]:border-primary data-[active]:text-foreground focus-visible:outline-ring'
  return <Tabs.Root value={tab} onValueChange={value => setParams(previous => { const next = new URLSearchParams(previous); next.set('tab', String(value)); return next }, { replace: true })} className="flex min-h-0 flex-1 flex-col">
    <Tabs.List aria-label="Student report sections" className="shrink-0 border-b px-2"><Tabs.Tab value="overview" className={tabClass}>Overview</Tabs.Tab><Tabs.Tab value="submissions" className={tabClass}>Submissions</Tabs.Tab><Tabs.Tab value="activity" className={tabClass}>Activity</Tabs.Tab></Tabs.List>
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <Tabs.Panel value="overview" className="space-y-5 outline-none"><section className="space-y-3 text-sm"><h3 className="font-medium">Latest saved submission</h3><Accepted value={student.accepted_submission} /><p className="text-muted-foreground">{student.practice_attempt_count} practice attempts · {student.accepted_submission_count} saved submissions · {student.remaining_submissions === null ? 'Unlimited remaining' : `${student.remaining_submissions} remaining`}</p>{!student.enrolled && <p className="text-muted-foreground">Historical student — no longer enrolled</p>}</section><section className="border-t pt-4"><IntegrityDetails value={student.integrity} /></section>{student.first_pass_at && <p className="text-xs text-muted-foreground">Earliest perfect execution: {new Date(student.first_pass_at).toLocaleString()}</p>}</Tabs.Panel>
      <Tabs.Panel value="submissions" className="space-y-3 outline-none"><h3 className="font-medium">Practice and final history</h3><PagedItems pageKey="historyPage" items={[...student.submissions].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))} empty="No executions recorded." render={item => <><p className="font-medium">{item.kind === 'final' ? `Final version ${item.version}` : 'Practice'} · Test score {item.score}%</p><p className="mt-1 text-xs text-muted-foreground">{new Date(item.created_at).toLocaleString()} · {item.passed}/{item.total} passed · {item.status}</p>{item.kind === 'final' && <p className="mt-1 text-xs font-medium">{item.status === 'ok' && item.total > 0 && item.passed === item.total ? 'Tests passed' : 'Pending teacher review'}</p>}{item.kind === 'final' && <Link className="mt-2 inline-block text-primary underline" to={`/submissions/${item.id}`} state={{ returnTo: location.pathname + location.search }}>View submitted code</Link>}</>} /></Tabs.Panel>
      <Tabs.Panel value="activity" className="space-y-3 outline-none"><h3 className="font-medium">Event timeline ({student.events.length})</h3><p className="text-xs text-muted-foreground">Newest first. Timestamps reflect server receipt.</p><PagedItems pageKey="activityPage" items={[...student.events].sort((a, b) => b.received_at.localeCompare(a.received_at) || b.event_id.localeCompare(a.event_id))} empty="No activity recorded." render={event => <><p>{event.type.replaceAll('_', ' ')}{typeof event.payload.chars === 'number' && ` · ${event.payload.chars} characters`}</p><time className="text-xs text-muted-foreground" dateTime={event.received_at}>{new Date(event.received_at).toLocaleString()}</time></>} /></Tabs.Panel>
    </div>
  </Tabs.Root>
}
