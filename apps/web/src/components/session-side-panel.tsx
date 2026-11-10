import { GitPullRequestIcon } from '@phosphor-icons/react'
import { Button } from '@openmanager/app-core/components/fluid/ui/button'
import { phosphorIcon } from '@openmanager/app-core/components/fluid/lib/icon-context'
import { SidePanel, useSidePanel } from '@openmanager/app-core/components/side-panel/SidePanel'

/**
 * The session view's right-hand panel. The shell renders this on session
 * pages only, inside the environment providers, so it may read the session
 * and its data. What it declares through <SidePanel> lands in two places: the
 * pill in the chat topbar's right end, the content in the panel.
 *
 * Integration point for pull requests: render
 * `<SidePanel available={prs.length > 0} title="Pull requests" pill={…}>`
 * with the pill hidden (null) and `available={false}` when the session links
 * none — then `]` does nothing and no pill shows.
 *
 * Until then it shows a placeholder, only when asked to (`placeholder`), so
 * the panel can be tried without data.
 */
export function SessionSidePanel({ placeholder = false }: { placeholder?: boolean }) {
  if (!placeholder) return null
  return (
    <SidePanel available title="Pull requests" pill={<PlaceholderPill />}>
      <PlaceholderContent />
    </SidePanel>
  )
}

const PullRequestIcon = phosphorIcon(GitPullRequestIcon)

function PlaceholderPill() {
  const { open, toggle } = useSidePanel()
  return (
    <Button
      variant="ghost"
      size="compact"
      active={open}
      aria-pressed={open}
      aria-label={open ? 'Hide pull requests' : 'Show pull requests'}
      onClick={toggle}
      leadingIcon={PullRequestIcon}
      className="max-md:h-9"
    >
      Pull requests
    </Button>
  )
}

function PlaceholderContent() {
  return (
    <section aria-label="Pull requests" className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center px-4 max-md:h-11">
        <h2 className="text-[12px] font-medium text-muted-foreground">Pull requests</h2>
      </div>
      <p className="px-4 pt-8 text-center text-[12px] text-faint">
        No pull requests linked to this session.
      </p>
    </section>
  )
}
