import { CourseStudents } from '@/components/course-students'
import { Notice } from "@/components/ui/notice"
import { useNotifications } from "@/hooks/use-notifications"
import { WorkspaceIcon } from "@/components/workspace-icon"
import { ContentSkeleton } from "@/components/loading-state"
import { Spinner } from "@/components/ui/spinner"
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { coursesApi, type Course } from '@/lib/courses'
import type { LabSummary } from '@/lib/types'
import { useAuth } from '@/components/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function useCourseData(id?: string) {
  const [state, setState] = useState<{ courses: Course[]; labs: LabSummary[]; loading: boolean; error: string }>({ courses: [], labs: [], loading: true, error: '' })
  const [attempt, retry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const request = id ? coursesApi.get(id, controller.signal).then(course => ({ courses: [{ ...course, lab_count: course.labs.length }], labs: course.labs })) : coursesApi.list(controller.signal).then(courses => ({ courses, labs: [] }))
    request.then(data => { if (!controller.signal.aborted) setState({ ...data, loading: false, error: '' }) }).catch(error => { if (!controller.signal.aborted) setState({ courses: [], labs: [], loading: false, error: error instanceof Error ? error.message : 'Unable to load courses.' }) })
    return () => controller.abort()
  }, [id, attempt])
  return { ...state, retry: () => { setState({ courses: [], labs: [], loading: true, error: '' }); retry(value => value + 1) } }
}

export function CoursesPage() {
  const { profile } = useAuth()
  const teacher = profile?.role === 'teacher'
  const data = useCourseData()
  const [query, setQuery] = useState('')
  const matches = data.courses.filter(course => course.title.toLowerCase().includes(query.toLowerCase()))
  return <section className="mx-auto w-full max-w-7xl space-y-8 p-4 sm:p-6 lg:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-3xl font-semibold">My courses</h1><p className="mt-2 max-w-2xl text-muted-foreground">{teacher ? 'Manage your classes, students, and Python labs.' : 'Your classes, practice labs, and a place to keep learning.'}</p></div>
      {teacher && <Button nativeButton={false} render={<Link to="/courses/new" />}><WorkspaceIcon name="add" />Create course</Button>}
    </header>
    <div className="flex flex-wrap items-end justify-between gap-4 border-b pb-5">
      <label className="block w-full space-y-2 text-sm font-medium sm:max-w-sm">Search your courses
        <div className="relative"><WorkspaceIcon name="search" className="pointer-events-none absolute left-3 top-3 text-muted-foreground" /><Input className="pl-10" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by title" /></div>
      </label>
      {!data.loading && !data.error && <p className="text-sm tabular-nums text-muted-foreground">{data.courses.length} {data.courses.length === 1 ? 'course' : 'courses'}<span className="mx-2" aria-hidden="true">·</span>{data.courses.reduce((sum, course) => sum + course.lab_count, 0)} labs available</p>}
    </div>
    <LoadState {...data} cards />
    {!data.loading && !data.error && (data.courses.length === 0 ? <Empty title="No courses yet" detail={teacher ? 'Create your first course to start organizing labs.' : 'Your enrolled courses will appear here. Ask your teacher to add you to a course.'} /> : matches.length === 0 ? <Empty title="No matching courses" detail="Try another title." /> :
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{matches.map(course =>
        <Link key={course.id} to={`/courses/${course.id}`} className="group flex min-h-64 flex-col rounded-xl border bg-card p-6 transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring">
          <div className="mb-5 flex items-center justify-between gap-3"><span className="font-mono text-sm text-primary" aria-hidden="true">{'{ python }'}</span><span className="text-sm tabular-nums text-muted-foreground">{course.lab_count} {course.lab_count === 1 ? 'lab' : 'labs'}</span></div>
          <h2 className="text-xl font-semibold leading-snug">{course.title}</h2>
          {course.description && <p className="mt-3 line-clamp-3 text-sm leading-6 text-muted-foreground">{course.description}</p>}
          <div className="mt-auto flex items-center justify-between gap-3 pt-6"><span className="text-sm font-medium text-primary">View course labs</span><WorkspaceIcon name="arrow" className="text-muted-foreground group-hover:text-primary" /></div>
          {teacher && course.student_count !== undefined && <p className="mt-3 border-t pt-3 text-sm text-muted-foreground">{course.student_count} {course.student_count === 1 ? 'student' : 'students'} enrolled</p>}
        </Link>)}</div>)}
  </section>
}

export function CoursePage() {
  const { courseId = '' } = useParams()
  return <CourseDetail key={courseId} id={courseId} />
}
function CourseDetail({ id }: { id: string }) {
  const data = useCourseData(id)
  const { profile } = useAuth()
  const course = data.courses[0]
  return <section className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
    <Link to="/courses" className="inline-flex items-center gap-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground"><WorkspaceIcon name="back" />All courses</Link>
    <LoadState {...data} />
    {course && <>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-6"><div className="max-w-2xl"><p className="mb-3 font-mono text-sm text-primary">{'{ python }'}</p><h1 className="text-3xl font-semibold">{course.title}</h1>{course.description && <p className="mt-3 leading-7 text-muted-foreground">{course.description}</p>}</div>{profile?.role === 'teacher' && <div className="flex flex-wrap items-center gap-2"><CourseStudents courseId={id} title={course.title} /><Button nativeButton={false} render={<Link to={`/courses/${id}/labs/new`} />}><WorkspaceIcon name="add" />Upload lab</Button></div>}</header>
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Course labs</h2><span className="text-sm tabular-nums text-muted-foreground">{data.labs.length} available</span></div>
      {data.labs.length === 0 ? <Empty title="No labs yet" detail="Labs shared in this course will appear here." /> :
        <div className="overflow-hidden rounded-xl border bg-card">{data.labs.map((lab, index) =>
          <Link key={lab.id} to={`/courses/${id}/labs/${lab.id}`} className="group flex items-center gap-4 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/60 sm:p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background font-mono text-sm tabular-nums text-muted-foreground" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <div className="min-w-0 flex-1"><h3 className="font-medium">{lab.title}</h3><p className="mt-1 text-sm text-muted-foreground">Python practice lab</p></div>
            <span className="hidden text-sm font-medium text-primary sm:inline">{profile?.role === 'teacher' ? 'Manage lab' : 'Open lab'}</span><WorkspaceIcon name="arrow" className="text-muted-foreground group-hover:text-primary" />
          </Link>)}</div>}
    </>}
  </section>
}

function LoadState({ loading, error, retry, cards = false }: { loading: boolean; error: string; retry: () => void; cards?: boolean }) {
  return <>{loading && <ContentSkeleton cards={cards} />}{error && <Notice tone="error" title="Unable to load this view" actions={<Button variant="outline" size="sm" onClick={retry}>Try again</Button>}>{error}</Notice>}</>
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="rounded-xl border bg-card px-6 py-12 text-center"><h2 className="font-semibold">{title}</h2><p className="mt-2 text-muted-foreground">{detail}</p></div>
}
export function CreateCoursePage() {
  return <section className="mx-auto w-full max-w-2xl space-y-6 p-6"><Link to="/courses" className="text-sm underline">All courses</Link><h1 className="text-3xl font-semibold">Create a course</h1><p className="text-muted-foreground">Set up a class and organize its Python labs.</p><CourseForm /></section>
}
function CourseForm({ courseId, onEnrolled }: { courseId?: string; onEnrolled?: () => void }) {
  const navigate = useNavigate()
  const { notify } = useNotifications()
  const lock = useRef(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (lock.current) return
    const form = event.currentTarget
    const data = new FormData(form)
    lock.current = true; setPending(true); setError(''); setSuccess('')
    try {
      if (courseId) {
        await coursesApi.enroll(courseId, String(data.get('email')).trim())
        if (active.current) { setSuccess('Enrollment confirmed. This student can access all existing and future labs in this course.'); form.reset(); onEnrolled?.() }
      } else {
        const title = String(data.get('title')).trim()
        if (!title) throw Error('Enter a course title.')
        const result = await coursesApi.create(title, String(data.get('description')))
        if (active.current) { notify('Course created', 'You can now add students and upload labs.'); navigate(`/courses/${result.id}`) }
      }
    } catch (error) { if (active.current) setError(error instanceof Error ? error.message : 'Request failed.') }
    finally { lock.current = false; if (active.current) setPending(false) }
  }
  return <form onSubmit={submit} className="space-y-4 rounded-xl border bg-card p-5"><fieldset disabled={pending} className="space-y-4">{courseId ? <><h2 className="font-semibold">Add a student</h2><p className="text-sm text-muted-foreground">Use the email of an existing student account.</p><label className="block space-y-2 text-sm font-medium">Student email<Input name="email" type="email" required autoComplete="off" /></label></> : <><label className="block space-y-2 font-medium">Course title<Input name="title" required maxLength={200} /></label><label className="block space-y-2 font-medium">Description (optional)<textarea name="description" maxLength={5000} rows={4} className="block w-full rounded-lg border border-input bg-card p-3" /></label></>}<Button type="submit">{pending && <Spinner />}{pending ? 'Saving…' : courseId ? 'Add student' : 'Create course'}</Button></fieldset>{error && <Notice tone="error" title={courseId ? "Student could not be added" : "Course could not be created"}>{error}</Notice>}{success && <Notice tone="success" title="Student enrolled">{success}</Notice>}</form>
}
