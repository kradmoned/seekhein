import { useCallback } from 'react'
import { Toast } from '@base-ui/react/toast'
import type { FeedbackTone } from '@/lib/feedback'

export function useNotifications() {
  const { add, close } = Toast.useToastManager()
  const notify = useCallback((title: string, description: string, tone: FeedbackTone = 'success', id?: string) => {
    return add({ id, title, description, type: tone, priority: 'low', timeout: tone === 'warning' ? 8000 : 6000 })
  }, [add])
  return { notify, dismiss: close }
}
