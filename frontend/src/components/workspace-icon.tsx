import { HugeiconsIcon } from '@hugeicons/react'
import { Alert02Icon, AlertCircleIcon, InformationCircleIcon, Cancel01Icon, Add01Icon, ArrowLeft01Icon, ArrowRight01Icon, BookOpen01Icon, CheckmarkCircle02Icon, Logout01Icon, PlayIcon, Search01Icon, Shield01Icon, SourceCodeIcon } from '@hugeicons/core-free-icons'

const icons = { warning: Alert02Icon, error: AlertCircleIcon, info: InformationCircleIcon, close: Cancel01Icon, add: Add01Icon, back: ArrowLeft01Icon, arrow: ArrowRight01Icon, book: BookOpen01Icon, check: CheckmarkCircle02Icon, logout: Logout01Icon, play: PlayIcon, search: Search01Icon, shield: Shield01Icon, code: SourceCodeIcon }
export function WorkspaceIcon({ name, className = '' }: { name: keyof typeof icons; className?: string }) {
  return <HugeiconsIcon icon={icons[name]} size={18} strokeWidth={1.5} aria-hidden="true" className={`shrink-0 ${className}`} />
}
