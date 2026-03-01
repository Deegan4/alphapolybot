import { Group, Panel, Separator } from 'react-resizable-panels'
import type { ComponentProps } from 'react'
import { cn } from '@/utils/cn'

type GroupProps = ComponentProps<typeof Group>
type PanelProps = ComponentProps<typeof Panel>
type SeparatorProps = ComponentProps<typeof Separator>

function ResizablePanelGroup({ className, ...props }: GroupProps) {
  return (
    <Group
      className={cn(
        'flex h-full w-full',
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel(props: PanelProps) {
  return <Panel {...props} />
}

function ResizableHandle({
  withHandle = false,
  className,
  ...props
}: SeparatorProps & { withHandle?: boolean }) {
  return (
    <Separator
      className={cn(
        'group relative flex w-[7px] items-center justify-center',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-[1px] after:-translate-x-1/2',
        'after:bg-agent-border after:transition-colors after:duration-200',
        'hover:after:bg-agent-green/40 active:after:bg-agent-green/60',
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex flex-col items-center justify-center gap-[3px] rounded-sm py-2 px-[2px] opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100">
          <span className="block h-[3px] w-[3px] rounded-full bg-agent-text-label group-hover:bg-agent-green/60" />
          <span className="block h-[3px] w-[3px] rounded-full bg-agent-text-label group-hover:bg-agent-green/60" />
          <span className="block h-[3px] w-[3px] rounded-full bg-agent-text-label group-hover:bg-agent-green/60" />
        </div>
      )}
    </Separator>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
