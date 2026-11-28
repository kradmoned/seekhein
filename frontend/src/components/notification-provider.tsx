import type { ReactNode } from 'react'
import { Toast } from '@base-ui/react/toast'
import { useAuth } from '@/components/auth-provider'
import { FeedbackIcon } from '@/components/ui/notice'
import { WorkspaceIcon } from '@/components/workspace-icon'
import type { FeedbackTone } from '@/lib/feedback'

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth()
  return <Toast.Provider key={profile?.id ?? 'signed-out'} timeout={6000} limit={2}>
    {children}
    <NotificationViewport />
  </Toast.Provider>
}

function NotificationViewport() {
  const { toasts } = Toast.useToastManager()
  return <Toast.Portal>
    <Toast.Viewport aria-label="Notifications" className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 outline-none">
      {toasts.map(toast => <Toast.Root key={toast.id} toast={toast} data-tone={toast.type} swipeDirection={['right', 'down']}
        className="feedback pointer-events-auto relative rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none transition-[opacity,transform] duration-150 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0 data-limited:hidden dark:shadow-none">
        <Toast.Content className="flex items-start gap-3 pr-7">
          <FeedbackIcon tone={(toast.type ?? 'info') as FeedbackTone} />
          <div className="min-w-0 flex-1"><Toast.Title className="text-sm font-medium leading-5" /><Toast.Description className="mt-1 break-words text-sm leading-6 text-muted-foreground" /></div>
        </Toast.Content>
        <Toast.Close aria-hidden={false} aria-label="Dismiss notification" className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><WorkspaceIcon name="close" /></Toast.Close>
      </Toast.Root>)}
    </Toast.Viewport>
  </Toast.Portal>
}
