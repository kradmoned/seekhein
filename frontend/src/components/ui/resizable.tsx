import { useId, useRef, useState, useSyncExternalStore, type ReactNode, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

const dividerSize = 4
const desktopQuery = '(min-width: 1024px)'
function subscribeDesktop(callback: () => void) {
  const query = window.matchMedia(desktopQuery)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

/** A split that preserves mounted children while resizing, including Monaco's model. */
export function ResizableSplit({
  first, second, direction = 'horizontal', defaultSize = 40,
  minFirst = 200, minSecond = 200, desktopOnly = false, label, className,
}: {
  first: ReactNode; second: ReactNode; direction?: 'horizontal' | 'vertical';
  defaultSize?: number; minFirst?: number; minSecond?: number; desktopOnly?: boolean;
  label: string; className?: string;
}) {
  const desktop = useSyncExternalStore(subscribeDesktop, () => window.matchMedia(desktopQuery).matches, () => true)
  const enabled = !desktopOnly || desktop
  const horizontal = direction === 'horizontal'
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; start: number; size: number } | null>(null)
  const [size, setSize] = useState(defaultSize)
  const [dragging, setDragging] = useState(false)
  const id = useId()
  function extent() {
    const rect = root.current?.getBoundingClientRect()
    return rect ? Math.max(1, (horizontal ? rect.width : rect.height) - dividerSize) : 1
  }
  function clamp(value: number) {
    const available = extent()
    const totalMinimum = minFirst + minSecond
    const scale = Math.min(1, available / totalMinimum)
    return Math.max(minFirst * scale / available * 100, Math.min(100 - minSecond * scale / available * 100, value))
  }
  function stop(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const track = `minmax(0, ${size}fr) ${dividerSize}px minmax(0, ${100 - size}fr)`
  return <div ref={root} data-slot="resizable-group" className={cn('relative min-h-0 min-w-0', !enabled && 'flex flex-col gap-1', className)}
    style={enabled ? { display: 'grid', [horizontal ? 'gridTemplateColumns' : 'gridTemplateRows']: track } : undefined}>
    <div id={`${id}-first`} className="min-h-0 min-w-0 overflow-hidden">{first}</div>
    <div
      role="separator" tabIndex={enabled ? 0 : -1} aria-label={label}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'} aria-controls={`${id}-first ${id}-second`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(size)}
      aria-valuetext={`${Math.round(size)} percent ${horizontal ? 'left' : 'top'} panel`}
      title="Drag or use arrow keys to resize. Double-click to reset."
      className={cn('group relative z-10 flex touch-none items-center justify-center rounded-sm outline-none hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring', horizontal ? 'cursor-col-resize after:absolute after:inset-y-0 after:-inset-x-1' : 'cursor-row-resize after:absolute after:inset-x-0 after:-inset-y-1', !enabled && 'hidden', dragging && 'bg-primary/10')}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointerId: event.pointerId, start: horizontal ? event.clientX : event.clientY, size }
        setDragging(true)
      }}
      onPointerMove={event => {
        if (drag.current?.pointerId !== event.pointerId) return
        const delta = (horizontal ? event.clientX : event.clientY) - drag.current.start
        setSize(clamp(drag.current.size + delta / extent() * 100))
      }}
      onPointerUp={stop} onPointerCancel={stop}
      onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
      onDoubleClick={() => setSize(clamp(defaultSize))}
      onKeyDown={event => {
        const decrease = horizontal ? 'ArrowLeft' : 'ArrowUp'
        const increase = horizontal ? 'ArrowRight' : 'ArrowDown'
        if (![decrease, increase, 'Home', 'End', 'Enter'].includes(event.key)) return
        event.preventDefault()
        const step = event.shiftKey ? 10 : 2
        setSize(clamp(event.key === 'Home' ? 0 : event.key === 'End' ? 100 : event.key === 'Enter' ? defaultSize : size + (event.key === decrease ? -step : step)))
      }}>
      <span aria-hidden="true" className={cn('rounded-full bg-muted-foreground/60 transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary/50', horizontal ? 'h-6 w-0.5' : 'h-0.5 w-6')} />
    </div>
    <div id={`${id}-second`} className="min-h-0 min-w-0 overflow-hidden">{second}</div>
    {dragging && <div className={cn('pointer-events-none absolute inset-0 z-20 select-none', horizontal ? 'cursor-col-resize' : 'cursor-row-resize')} />}
  </div>
}
