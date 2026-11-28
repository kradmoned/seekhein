import { ApiError } from '@/lib/api'
import { labValidation, type LabValidation, type UploadSuccess } from '@/lib/lab-validation'
import { UploadDiagnostics } from '@/components/upload-diagnostics'
import { Notice } from "@/components/ui/notice"
import { LimitSelect } from "@/components/submission-limit"
import { parseLimit } from "@/lib/submission-contract"
import { Spinner } from "@/components/ui/spinner"
import { useState, useRef, useEffect, type FormEvent } from "react"
import { Link, useParams } from "react-router"
import { coursesApi } from "@/lib/courses"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const fileFields = ["instructions", "starter", "tests", "solution"] as const

export function UploadLabPage() {
  const { courseId = "" } = useParams()
  const active = useRef(true)
  const submitting = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const [titleValue, setTitleValue] = useState('')
  const [files, setFiles] = useState<Partial<Record<(typeof fileFields)[number], File>>>({})
  const [maxSubmissions, setMaxSubmissions] = useState("1")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [diagnostics, setDiagnostics] = useState<LabValidation | null>(null)
  const [saved, setSaved] = useState<UploadSuccess | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [retryBlocked, setRetryBlocked] = useState(false)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(retryTimer.current), [])

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || uncertain || retryBlocked || saved) return
    submitting.current = true

    const form = new FormData(event.currentTarget)
    const title = titleValue.trim()
    for (const field of fileFields) { const file = files[field]; if (file) form.set(field, file); else form.delete(field) }
    setError(""); setDiagnostics(null)
    setPending(true)

    let requestStarted = false
    try {
      if (!title) throw new Error("A lab title is required.")
      form.set("title", title)
      const limit = parseLimit(maxSubmissions)
      form.set("max_submissions", limit === null ? "unlimited" : String(limit))

      for (const field of fileFields) {
        const entries = form.getAll(field)
        const file = entries[0]

        if (entries.length !== 1 || !(file instanceof File) || !file.name) {
          throw new Error(`Upload exactly one ${field} file.`)
        }

        if (file.size > (field === 'instructions' ? 1_048_576 : 65_536)) {
          throw new Error(`${field} exceeds the ${field === 'instructions' ? '1 MiB' : '64 KiB'} upload limit.`)
        }

        let text: string

        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            await file.arrayBuffer(),
          )
        } catch {
          throw new Error(`${field} must contain valid UTF-8 text.`)
        }

        if (text.includes('\0')) throw new Error(`${field} must not contain null characters.`)
        if (!text.trim()) {
          throw new Error(`${field} must contain non-whitespace text.`)
        }
      }

      requestStarted = true
      const result = await coursesApi.upload(courseId, form)

      if (active.current) setSaved(result)
    } catch (error) {
      if (!active.current) return
      setError(error instanceof Error ? error.message : 'Upload failed.')
      if (error instanceof ApiError && error.code === 'LAB_VALIDATION_FAILED') {
        try { setDiagnostics(labValidation((error.details as { validation?: unknown })?.validation)) }
        catch { setError('The backend returned invalid validation diagnostics. Your files are retained.') }
      } else if (!(error instanceof ApiError) || error.status === 0 || error.status === 500) {
        // Only uncertain request outcomes need a duplicate-check; local file errors do not.
        if (requestStarted) setUncertain(true)
      }
      if (error instanceof ApiError && error.status === 429) {
        setRetryBlocked(true)
        retryTimer.current = setTimeout(() => { if (active.current) setRetryBlocked(false) }, Math.max(2, error.retryAfter ?? 2) * 1000)
      }
    } finally {
      submitting.current = false
      if (active.current) setPending(false)
    }
  }

  return (
    <section className="mx-auto max-w-2xl space-y-6 p-6">
      <Link className="text-sm underline" to={`/courses/${courseId}`}>Back to course</Link>
      <header>
        <h1 className="text-2xl font-semibold">Upload a lab</h1>
        <p className="mt-2 text-muted-foreground">
          Provide instructions, starter code, the complete test suite, and a reference solution.
        </p>
      </header>

      <div className="space-y-2 rounded-xl border p-4 text-sm">
        <p>Instructions: up to 1 MiB. Starter, tests, and solution: up to 64 KiB each. All files must be nonempty UTF-8 text without null characters.</p>
        <p>
          Execution requires a test file of at most 64 KiB, written using
          unittest.TestCase methods. Bare test_* functions and expect(...) are incompatible.
        </p>
        <p>The reference solution must pass all supplied tests before the lab is saved. Tests must import submitted symbols from solution.</p>
      </div>

      {saved && <Notice tone="success" title="Lab validated and saved"><p>{saved.validation.passed_tests}/{saved.validation.total_tests} tests passed · {new Date(saved.validated_at).toLocaleString()}</p>{saved.validation.warnings.length > 0 && <ul className="mt-2 list-disc pl-4">{saved.validation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}<Link className="mt-3 inline-block underline" to={`/courses/${courseId}/labs/${saved.id}`}>Open saved lab</Link></Notice>}
      {!saved && <form onSubmit={upload} className="space-y-5">
        <fieldset disabled={pending} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="title" className="font-medium">Lab title</label>
            <Input id="title" name="title" value={titleValue} onChange={event => setTitleValue(event.target.value)} required />
          </div>

          <LimitSelect value={maxSubmissions} onChange={setMaxSubmissions} disabled={pending} />

          {fileFields.map((field) => (
            <div key={field} className="space-y-2">
              <label htmlFor={field} className="font-medium capitalize">{field}</label>
              <Input
                id={field}
                name={field}
                type="file"
                accept={field === "instructions" ? ".md,.markdown" : ".py"}
                required
                onChange={event => { const file = event.target.files?.[0]; setFiles(previous => ({ ...previous, [field]: file })) }}
              />
            </div>
          ))}

          {error && (
            <Notice tone="error" title="Lab could not be uploaded">{error}</Notice>
          )}

          <Button type="submit" disabled={uncertain || retryBlocked}>{pending && <Spinner />}{pending ? 'Validating reference solution and saving lab…' : retryBlocked ? 'Runner busy — wait before retrying' : error ? 'Retry upload' : 'Upload lab'}</Button>
        </fieldset>
      </form>}
      {diagnostics && <UploadDiagnostics value={diagnostics} />}
      {uncertain && <Notice tone="warning" title="Upload outcome is uncertain"><p>The lab may already have been saved. Check the course labs before retrying to avoid duplicates. Your selected files are retained here.</p><a className="mt-2 block underline" href={`/courses/${courseId}`} target="_blank" rel="noopener noreferrer">Check course labs in a new tab</a><Button className="mt-3" variant="outline" onClick={() => setUncertain(false)}>I checked — allow retry</Button></Notice>}
    </section>
  )
}