import type { IntegrityPolicy } from '@/lib/integrity'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription, PopoverTrigger } from '@/components/ui/popover'
import { WorkspaceIcon } from '@/components/workspace-icon'

export function LabRules({ policy }: { policy: IntegrityPolicy }) {
  return <Popover>
    <PopoverTrigger render={<Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground" />}><WorkspaceIcon name="shield" /><span>Lab rules</span></PopoverTrigger>
    <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] rounded-xl">
      <PopoverHeader><PopoverTitle>Working in this lab</PopoverTitle><PopoverDescription>Practice freely within your teacher’s editor policy.</PopoverDescription></PopoverHeader>
      <ul className="list-disc space-y-2 pl-4 text-sm">
        <li>Tab changes and window focus are recorded for teacher review</li>
        {policy.block_paste && <li>You can paste text copied or cut from this lab editor; external pastes are blocked</li>}
        {policy.block_drop && <li>Dragging text into the editor is disabled</li>}
        {policy.block_large_insert && <li>Insertions above {policy.large_insert_threshold} characters at once are blocked, except approved copies from this editor</li>}
        <li>Practice runs do not use your final submission allowance</li>
      </ul>
    </PopoverContent>
  </Popover>
}
