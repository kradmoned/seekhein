import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function ButtonGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div role="group" data-slot="button-group" className={cn(
    'inline-flex w-fit items-stretch [&>*]:rounded-none [&>*:first-child]:rounded-l-md [&>*:last-child]:rounded-r-md [&>*:focus-visible]:relative [&>*:focus-visible]:z-10',
    className,
  )} {...props} />
}
