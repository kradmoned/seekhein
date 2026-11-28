import { Notice } from "@/components/ui/notice"
import { ContentSkeleton } from "@/components/loading-state"
import { useEffect, useState } from "react"
import { Link } from "react-router"
import { api } from "@/lib/api"
import type { LabSummary } from "@/lib/types"
import { useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"

export function LabsPage() {
  const { profile } = useAuth()
  const [search, setSearch] = useState("")
  const [labs, setLabs] = useState<LabSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError("")

    api<LabSummary[]>("/api/labs", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setLabs(value) })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [attempt])

  return (
    <section className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Python labs</h1>
          <p className="text-muted-foreground">Choose a lab to begin.</p>
        </div>
        {profile?.role === "teacher" && (
          <Link className="underline" to="/labs/new">Upload lab</Link>
        )}
      </header>

      {loading && <ContentSkeleton label="Loading labs…" cards />}

      {error && (
        <Notice tone="error" title="Labs could not be loaded" actions={<Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>Try again</Button>}>{error}</Notice>
      )}

      {!loading && !error && labs.length === 0 && <p>No labs available yet.</p>}

      <label className="block text-sm font-medium">Search lab titles (on this page)<input type="search" value={search} onChange={event => setSearch(event.target.value)} className="mt-2 block w-full rounded-lg border bg-card px-4 py-3" placeholder="Find a Python lab…" /></label>
      {!loading && !error && labs.length > 0 && !labs.some(lab => lab.title.toLowerCase().includes(search.toLowerCase())) && <p>No matching titles.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {!loading && !error && labs.filter(lab => lab.title.toLowerCase().includes(search.toLowerCase())).map((lab) => (
          <Link
            key={lab.id}
            to={`/labs/${lab.id}`}
            className="rounded-xl border bg-card p-5 transition-colors hover:bg-muted"
          >
            <h2 className="font-semibold">{lab.title}</h2>
          </Link>
        ))}
      </div>
    </section>
  )
}