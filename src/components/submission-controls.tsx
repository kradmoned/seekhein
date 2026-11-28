import { reviewLabel } from '@/lib/submission-contract'
import { Notice } from "@/components/ui/notice"
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { codeDigest } from '@/lib/pending-submissions'
import type { useSubmissions } from '@/hooks/use-submissions'
import type { RunResult } from '@/lib/types'

type Props = {
  submission: ReturnType<typeof useSubmissions>; code: string; editorReady: boolean; runBusy: boolean;
  getCode: () => string; flush: () => Promise<void>; onResult: (result: RunResult, code: string) => void;
  offerSubmitAnyway?: boolean; open: boolean; onOpenChange: (open: boolean) => void;
}
export function SubmissionControls({ submission: s, code, editorReady, runBusy, getCode, flush, onResult, open, onOpenChange, offerSubmitAnyway }: Props) {
  const accepted = s.status?.accepted_submission
  const [comparison, setComparison] = useState<{ code: string; digest: string; changed: boolean | null } | null>(null)
  useEffect(() => {
    let current = true
    if (accepted) void codeDigest(code).then(digest => {
      if (current) setComparison({ code, digest: accepted.code_sha256, changed: digest !== accepted.code_sha256 })
    }).catch(() => { if (current) setComparison({ code, digest: accepted.code_sha256, changed: null }) })
    return () => { current = false }
  }, [code, accepted])
  const compared = comparison?.code === code && comparison.digest === accepted?.code_sha256
  const needsAttention = !!s.statusError || !!s.storageError || s.pending.length > 0
  const disabled = !editorReady || s.loading || !!s.statusError || !!s.storageError || s.busy || runBusy || s.pending.length > 0 || !s.status?.can_submit
  return <Popover open={open} onOpenChange={onOpenChange}>
    <ButtonGroup aria-label="Final submission actions">
      <Button size="sm" disabled={disabled}
        onClick={() => { const snapshot = getCode(); void s.submit(snapshot, flush, onResult) }}>
        {(s.busy || s.loading) && <Spinner />}
        {s.busy ? 'Submitting…' : s.loading ? 'Loading…' : s.status && !s.status.can_submit ? 'Submitted' : accepted ? 'Submit another version' : 'Submit'}
      </Button>
      <PopoverTrigger render={<Button size="icon-sm" className="relative border-l-primary-foreground/25" aria-label="Submission details" title="Submission details" />}>
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
        {needsAttention && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-300 ring-1 ring-primary" aria-hidden="true" />}
        {needsAttention && <span className="sr-only">Needs attention</span>}
      </PopoverTrigger>
    </ButtonGroup>
    {offerSubmitAnyway && <Button size="sm" variant="outline" disabled={disabled} onClick={() => onOpenChange(true)}>Submit anyway…</Button>}
    <PopoverContent align="end" sideOffset={8} className="max-h-[min(32rem,var(--available-height))] w-[min(23rem,calc(100vw-2rem))] gap-4 overflow-y-auto rounded-xl" aria-label="Submission details">
      <PopoverHeader><PopoverTitle>Submission details</PopoverTitle><PopoverDescription>Saved submissions and your remaining allowance.</PopoverDescription></PopoverHeader>
      {s.loading ? <p role="status" className="flex items-center gap-2"><Spinner />Loading saved submission status…</p> : s.status &&
        <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3">
          <div><dt className="text-xs text-muted-foreground">Saved</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{s.status.accepted_submission_count}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Maximum</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{s.status.max_submissions ?? 'Unlimited'}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Remaining</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{s.status.remaining_submissions ?? 'Unlimited'}</dd></div>
        </dl>}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">Last saved submission</h3>
        {accepted ? <><p className="font-medium">Saved version {accepted.version}</p><time className="block text-muted-foreground" dateTime={accepted.submitted_at}>{new Date(accepted.submitted_at).toLocaleString()}</time><p className="font-medium">{reviewLabel(accepted)}</p><p>Test score {accepted.execution.score}% · {accepted.execution.passed}/{accepted.execution.total} passed</p><p className="text-muted-foreground">{compared ? comparison.changed === null ? 'Unable to compare editor content in this browser.' : comparison.changed ? 'Your editor differs from the saved submission.' : 'Your editor matches the saved submission.' : 'Comparing editor with the saved submission…'}</p></> : <p className="text-muted-foreground">No saved submission yet.</p>}
      </div>
      {s.statusError && <Notice tone="error" title="Status could not be loaded" actions={<Button variant="outline" size="sm" onClick={() => void s.refresh()}>Retry status</Button>}>{s.statusError}</Notice>}
      {s.storageError && <Notice tone="error" title="Recovery storage needs attention" actions={<Button variant="outline" size="sm" onClick={s.readPending}>Retry storage</Button>}>{s.storageError}</Notice>}
      {s.pending.length > 0 && <div className="space-y-3 border-t pt-3"><h3 className="font-medium">Pending recovery ({s.pending.length})</h3><p className="text-muted-foreground">Recovery sends the original code and submission mode, even if you have edited it since.</p>{s.pending.map(item => <div key={item.key} className="space-y-1"><Button size="sm" variant="outline" disabled={s.busy || runBusy} onClick={() => s.recover(item, onResult)}>Recover pending submission</Button><span className="block text-xs text-muted-foreground">{item.submit_anyway ? 'Submit anyway' : 'Ordinary submit'}</span><span className="block break-all font-mono text-[10px] text-muted-foreground">{item.key}</span></div>)}</div>}
      <section className="space-y-2 border-t pt-3"><h3 className="font-medium">Hand in unfinished work</h3><p className="text-sm text-muted-foreground">Submit anyway runs your current code again and saves it even if tests fail. It uses one submission slot.{s.status?.remaining_submissions === 1 ? ' This is your last slot; another version will require your teacher to raise the limit.' : ''}</p><Button size="sm" variant="outline" disabled={disabled} onClick={() => { const snapshot = getCode(); void s.submit(snapshot, flush, onResult, true); onOpenChange(false) }}>Submit anyway</Button></section>
      <p className="border-t pt-3 text-xs text-muted-foreground">All saved versions use your allowance, including unfinished work. Rejected ordinary submissions and practice runs do not count.</p>
    </PopoverContent>
  </Popover>
}
