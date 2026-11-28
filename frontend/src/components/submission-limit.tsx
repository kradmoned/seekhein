import { Notice } from "@/components/ui/notice"
import { useNotifications } from "@/hooks/use-notifications"
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { check, object, parseLimit, validLimit } from '@/lib/submission-contract'

export function LimitSelect({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="block space-y-2 text-sm font-medium">Maximum submissions<select name="max_submissions" value={value} onChange={event => onChange(event.target.value)} disabled={disabled} className="block w-full rounded-md border bg-background p-2">{!['1', '2', '3', 'unlimited'].includes(value) && <option value={value}>{value}</option>}<option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="unlimited">Unlimited</option></select><span className="block font-normal text-muted-foreground">Counts all saved versions, including unfinished work. Rejected ordinary submissions and practice runs do not count.</span></label>
}
export function EditSubmissionLimit({ labId, initial }: { labId: string; initial: number | null }) {
  const [value, setValue] = useState(initial === null ? 'unlimited' : String(initial))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const { notify } = useNotifications()
  return <form className="space-y-2 rounded-sm border bg-card p-3" onSubmit={async event => {
    event.preventDefault(); if (pending) return
    setPending(true); setError('')
    try {
      const response = object(await api<unknown>(`/api/labs/${encodeURIComponent(labId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_submissions: parseLimit(value) }) }))
      check(response.id === labId && validLimit(response.max_submissions) && typeof response.allow_resubmissions === 'boolean')
      setValue(response.max_submissions === null ? 'unlimited' : String(response.max_submissions))
      notify('Submission limit saved', 'Earlier saved versions are preserved.', 'success', `policy:${labId}`)
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save limit.') }
    finally { setPending(false) }
  }}><div className="flex flex-wrap items-end gap-3"><LimitSelect value={value} onChange={setValue} disabled={pending} /><Button disabled={pending} type="submit" size="sm">{pending ? 'Saving…' : 'Save limit'}</Button></div>{error && <Notice tone="error" title="Limit could not be saved">{error}</Notice>}</form>
}
