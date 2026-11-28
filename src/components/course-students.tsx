import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Tabs } from '@base-ui/react/tabs'
import { coursesApi, type CourseStudent } from '@/lib/courses'
import { ApiError } from '@/lib/api'
import { enrollmentCsv } from '@/lib/enrollment-csv'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Notice } from '@/components/ui/notice'
import { Spinner } from '@/components/ui/spinner'
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'

type ImportRow = { email: string; status: 'pending' | 'success' | 'error'; message?: string }
const tabClass = 'border-b-2 border-transparent px-4 py-3 text-sm text-muted-foreground data-[active]:border-primary data-[active]:text-foreground focus-visible:outline-ring'

export function CourseStudents({ courseId, title }: { courseId: string; title: string }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<string | number | null>('roster')
  const [students, setStudents] = useState<CourseStudent[]>([])
  const [loading, setLoading] = useState(true)
  const [rosterError, setRosterError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [rows, setRows] = useState<ImportRow[]>([])
  const [duplicates, setDuplicates] = useState(0)
  const [csvErrors, setCsvErrors] = useState<string[]>([])
  const [fileName, setFileName] = useState('')
  const lock = useRef(false)
  const stop = useRef(false)
  const request = useRef<AbortController | null>(null)
  const fileVersion = useRef(0)
  useEffect(() => () => { request.current?.abort(); fileVersion.current++ }, [])
  useEffect(() => {
    const controller = new AbortController()
    coursesApi.students(courseId, controller.signal).then(value => {
      if (!controller.signal.aborted) { setStudents(value); setRosterError('') }
    }).catch(error => {
      if (!controller.signal.aborted) setRosterError(error instanceof Error ? error.message : 'Unable to load students.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [courseId, refresh])
  function refreshRoster() { setLoading(true); setRefresh(value => value + 1) }
  async function addStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current) return
    const form = event.currentTarget
    const email = String(new FormData(form).get('email')).trim()
    lock.current = true; setBusy(true); setError(''); setMessage('')
    const controller = new AbortController(); request.current = controller
    try {
      await coursesApi.enroll(courseId, email, controller.signal)
      if (!controller.signal.aborted) { setMessage(`${email} is enrolled.`); form.reset(); refreshRoster() }
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Student could not be added.')
    } finally { lock.current = false; if (!controller.signal.aborted) { setBusy(false); setImporting(false) } }
  }
  async function readCsv(file?: File) {
    const version = ++fileVersion.current
    setRows([]); setCsvErrors([]); setDuplicates(0); setFileName(file?.name ?? ''); setMessage(''); setError('')
    if (!file) return
    try {
      if (file.size > 1_048_576) throw Error('Choose a CSV smaller than 1 MiB.')
      const preview = enrollmentCsv(await file.text())
      if (version !== fileVersion.current) return
      setRows(preview.emails.map(email => ({ email, status: 'pending' }))); setDuplicates(preview.duplicates); setCsvErrors(preview.errors)
    } catch (error) { if (version === fileVersion.current) setCsvErrors([error instanceof Error ? error.message : 'Could not read this CSV.']) }
  }
  async function importStudents() {
    if (lock.current || csvErrors.length || !rows.length) return
    lock.current = true; stop.current = false; setImporting(true); setBusy(true); setError(''); setMessage('')
    const controller = new AbortController(); request.current = controller
    const next = rows.map(row => ({ ...row }))
    try {
      for (let index = 0; index < next.length; index++) {
        if (stop.current || controller.signal.aborted) break
        if (next[index].status === 'success') continue
        try {
          await coursesApi.enroll(courseId, next[index].email, controller.signal)
          next[index] = { ...next[index], status: 'success', message: undefined }
        } catch (error) {
          if (controller.signal.aborted) break
          next[index] = { ...next[index], status: 'error', message: error instanceof Error ? error.message : 'Enrollment failed.' }
          // Stop repeated requests when access, connectivity, or rate limits need attention.
          if (!(error instanceof ApiError) || [0, 401, 403, 429].includes(error.status) || error.status >= 500) stop.current = true
        }
        if (!controller.signal.aborted) setRows([...next])
      }
      if (!controller.signal.aborted) {
        setMessage(`${next.filter(row => row.status === 'success').length} of ${next.length} enrollments confirmed${stop.current ? '. Import stopped; remaining rows can be retried.' : '.'}`)
        refreshRoster()
      }
    } finally { lock.current = false; if (!controller.signal.aborted) { setBusy(false); setImporting(false) } }
  }
  const matches = students.filter(student => `${student.full_name ?? ''} ${student.email}`.toLowerCase().includes(query.toLowerCase()))
  const remaining = rows.filter(row => row.status !== 'success').length
  return <Sheet open={open} onOpenChange={value => { if (!lock.current) setOpen(value) }}>
    <SheetTrigger render={<Button variant="outline" />}>Students{!loading && !rosterError && <span className="text-muted-foreground tabular-nums">{students.length}</span>}</SheetTrigger>
    <SheetContent side="right" className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl" showCloseButton={!busy}>
      <SheetHeader className="shrink-0 border-b pr-14"><SheetTitle>Course students</SheetTitle><SheetDescription className="break-words">{title}</SheetDescription></SheetHeader>
      <Tabs.Root value={tab} onValueChange={value => { if (!busy) setTab(value) }} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List aria-label="Student management" className="shrink-0 border-b px-2"><Tabs.Tab value="roster" disabled={busy} className={tabClass}>Enrolled students</Tabs.Tab><Tabs.Tab value="add" disabled={busy} className={tabClass}>Add students</Tabs.Tab></Tabs.List>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <Tabs.Panel value="roster" className="space-y-4 outline-none">
            <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{loading ? 'Loading students…' : `${students.length} enrolled`}</p><Button size="sm" variant="outline" onClick={() => setTab('add')}>Add students</Button></div>
            <Input type="search" aria-label="Search enrolled students" placeholder="Search name or email" value={query} onChange={event => setQuery(event.target.value)} />
            {rosterError && <Notice tone="error" title="Roster could not be loaded" actions={<Button size="sm" variant="outline" onClick={refreshRoster}>Retry roster</Button>}>{rosterError}</Notice>}
            {!loading && !rosterError && (students.length === 0 ? <p className="py-8 text-center text-muted-foreground">No students enrolled yet. Add an existing student account to give them access to course labs.</p> : matches.length === 0 ? <p className="text-muted-foreground">No students match your search.</p> : <ul className="divide-y">{matches.map(student => <li key={student.id}><Link to={`/courses/${courseId}/students/${student.id}/report`} className="group flex items-center justify-between gap-3 rounded-md py-4 focus-visible:outline-ring hover:bg-muted/50"><div className="min-w-0"><p className="break-words font-medium">{student.full_name || student.email}</p>{student.full_name && <p className="break-all text-sm text-muted-foreground">{student.email}</p>}<p className="mt-1 text-xs text-muted-foreground">Enrolled {new Date(student.enrolled_at).toLocaleDateString()}</p></div><span className="shrink-0 text-xs text-primary">View report →</span></Link></li>)}</ul>)}
          </Tabs.Panel>
          <Tabs.Panel value="add" className="space-y-6 outline-none">
            <p className="text-sm text-muted-foreground">Students need an existing account. Enrollment gives access to all labs in this course.</p>
            <form onSubmit={addStudent} className="space-y-3"><fieldset disabled={busy} className="space-y-3"><label className="block space-y-2 font-medium">Student email<Input name="email" type="email" required autoComplete="off" placeholder="student@example.com" /></label><Button type="submit">Add student</Button></fieldset></form>
            <section className="space-y-3 border-t pt-5" aria-label="CSV enrollment"><h3 className="font-medium">Import a class</h3><p className="text-sm text-muted-foreground">Upload a UTF-8 CSV with an <code>email</code> column, up to 200 rows. Review the preview before enrolling.</p><a className="inline-block text-sm text-primary underline" href="data:text/csv;charset=utf-8,email%0Astudent%40example.com%0A" download="students-template.csv">Download CSV template</a>
              <Input type="file" aria-label="Student CSV file" accept=".csv,text/csv" disabled={busy} onChange={event => void readCsv(event.target.files?.[0])} />
              {csvErrors.length > 0 && <Notice tone="error" title="Fix the CSV before importing"><ul className="space-y-1">{csvErrors.map((error, i) => <li key={i}>{error}</li>)}</ul></Notice>}
              {rows.length > 0 && <><p className="break-all text-sm text-muted-foreground">{fileName} · {rows.length} unique emails{duplicates > 0 && ` · ${duplicates} duplicates skipped`}</p><ul className="max-h-64 divide-y overflow-auto rounded-lg border px-3" aria-label="CSV preview">{rows.map(row => <li key={row.email} className="py-2"><div className="flex items-start justify-between gap-2"><span className="break-all text-sm">{row.email}</span><span className={`shrink-0 text-xs ${row.status === 'error' ? 'text-destructive' : row.status === 'success' ? 'text-success' : 'text-muted-foreground'}`}>{row.status === 'success' ? 'Enrolled' : row.status === 'error' ? 'Failed' : 'Ready'}</span></div>{row.message && <p className="mt-1 text-xs text-destructive">{row.message}</p>}</li>)}</ul><Button disabled={busy || csvErrors.length > 0 || remaining === 0} onClick={() => void importStudents()}>{remaining === 0 ? 'All students enrolled' : rows.some(row => row.status !== 'pending') ? 'Retry remaining students' : `Enroll ${remaining} students`}</Button></>}
            </section>
            {busy && <p role="status" className="flex items-center gap-2 text-sm"><Spinner />Saving enrollment…{importing && <Button size="sm" variant="ghost" onClick={() => { stop.current = true }}>Stop after current request</Button>}</p>}
            {error && <Notice tone="error" title="Student could not be added">{error}</Notice>}
            {message && <Notice tone="info" title="Enrollment update">{message}</Notice>}
          </Tabs.Panel>
        </div>
      </Tabs.Root>
    </SheetContent>
  </Sheet>
}
