import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'

export function LoadingStatus({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div role="status" className={`flex items-center gap-2 text-sm text-muted-foreground ${className}`}><Spinner /><span>{children}</span></div>
}

export function ContentSkeleton({ label = 'Loading…', cards = false }: { label?: string; cards?: boolean }) {
  return <div className="space-y-4">
    <LoadingStatus>{label}</LoadingStatus>
    <div aria-hidden="true" className={cards ? 'grid gap-5 sm:grid-cols-2 xl:grid-cols-3' : 'space-y-3'}>
      {Array.from({ length: cards ? 6 : 3 }, (_, index) => <div key={index} className="space-y-3 rounded-sm border bg-card p-5">
        {cards && <Skeleton className="mb-5 size-10 rounded-sm" />}
        <Skeleton className="h-4 w-2/3 rounded-sm" /><Skeleton className="h-3 w-5/6 rounded-sm" />
        {cards && <Skeleton className="mt-6 h-3 w-1/3 rounded-sm" />}
      </div>)}
    </div>
  </div>
}

export function LabSkeleton() {
  return <div className="flex min-h-full flex-col gap-2 p-2 lg:h-full lg:min-h-0">
    <LoadingStatus className="px-2 py-1">Loading lab…</LoadingStatus>
    <div aria-hidden="true" className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      {[0, 1].map(panel => <div key={panel} className="min-h-64 space-y-5 rounded-sm border bg-card p-4">
        <Skeleton className="mb-8 h-5 w-1/3 rounded-sm" />
        {Array.from({ length: 7 }, (_, line) => <Skeleton key={line} className={`h-3 rounded-sm ${line % 3 === 0 ? 'w-1/2' : 'w-5/6'}`} />)}
      </div>)}
    </div>
  </div>
}
