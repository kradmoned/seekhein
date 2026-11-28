import { useId, type ReactNode } from 'react'
import { WorkspaceIcon } from '@/components/workspace-icon'
import type { FeedbackTone } from '@/lib/feedback'
import { cn } from '@/lib/utils'

export function FeedbackIcon({ tone }: { tone: FeedbackTone }) {
  const icon = { info: 'info', success: 'check', warning: 'warning', error: 'error' } as const
  return <span className="feedback-icon flex size-8 shrink-0 items-center justify-center rounded-lg"><WorkspaceIcon name={icon[tone]} /></span>
}

export function Notice({ tone = 'info', title, children, actions, className }: {
  tone?: FeedbackTone; title: string; children?: ReactNode; actions?: ReactNode; className?: string;
}) {
  const id = useId()
  return <div role={tone === 'error' ? 'alert' : 'status'} aria-labelledby={id} data-tone={tone}
    className={cn('feedback flex items-start gap-3 rounded-lg border bg-card p-3 text-sm text-foreground', className)}>
    <FeedbackIcon tone={tone} />
    <div className="min-w-0 flex-1">
      <p id={id} className="font-medium leading-5">{title}</p>
      {children && <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{children}</div>}
      {actions && <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  </div>
}
