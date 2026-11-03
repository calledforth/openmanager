import { useNavigate } from '@tanstack/react-router'
import { GearSixIcon } from '@phosphor-icons/react'
import { useSidebar } from '@openmanager/app-core/components/fluid/ui/sidebar'
import { UsageDockButton } from '@openmanager/app-core/components/usage/UsageLimits'
import { Tooltip } from '@openmanager/app-core/components/ui/Tooltip'
import { cn } from '@openmanager/app-core/lib/utils'

/** One square control on the dock. The current page is a fill, never an outline. */
export const dockButtonClass = (active: boolean) =>
  cn(
    'grid h-7 w-[30px] cursor-pointer place-items-center rounded-[9px] transition-colors duration-100',
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
    active
      ? 'bg-active text-foreground'
      : 'text-muted-foreground hover:bg-hover hover:text-foreground',
  )

/**
 * The sidebar's footer: the shell's own pages as icons on one small raised
 * pill. Usage is a live ring for the 5-hour window (hover for every window),
 * Settings a gear. Names live in tooltips and accessible labels.
 */
export function SidebarDock({ pathname }: { pathname: string }) {
  const navigate = useNavigate()
  // On a phone the sidebar is a sheet over the page; going somewhere closes it.
  const { isMobile, setOpenMobile } = useSidebar()
  const go = (to: '/usage' | '/settings') => {
    if (isMobile) setOpenMobile(false)
    void navigate({ to })
  }
  const onUsage = pathname === '/usage'
  const onSettings = pathname === '/settings'
  return (
    <nav aria-label="Primary" className="flex px-1 pb-0.5">
      <div className="inline-flex items-center gap-0.5 rounded-[12px] bg-float p-[3px] shadow-float-rest">
        <UsageDockButton
          active={onUsage}
          onOpenPage={() => go('/usage')}
          className={dockButtonClass(onUsage)}
        />
        <Tooltip content="Settings">
          <button
            type="button"
            aria-label="Settings"
            aria-current={onSettings ? 'page' : undefined}
            onClick={() => go('/settings')}
            className={dockButtonClass(onSettings)}
          >
            <GearSixIcon className="size-4" />
          </button>
        </Tooltip>
      </div>
    </nav>
  )
}
