import { cn } from '@/lib/utils'

/** Decorative; pair with visible pending text or an accessible status label. */
export function Spinner({ className }: { className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={cn('size-4 shrink-0 animate-spin motion-reduce:animate-none', className)}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
    <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
}
