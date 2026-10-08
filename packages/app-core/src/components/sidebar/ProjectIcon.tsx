import { useContext, useEffect, useState, type ComponentType } from 'react'
import { FolderSimpleIcon } from '@phosphor-icons/react'
import {
  useViewActions,
  WORKSPACE_ICONS_UNSET,
  WorkspaceIconContext,
  type ViewActions,
} from '../../providers/view-actions'
import { cn } from '../../lib/utils'

// Preserve instant remounts without mixing icons from different hosts/environments.
const iconCaches = new WeakMap<
  NonNullable<ViewActions['resolveWorkspaceIcon']>,
  Map<string, string | null>
>()

interface ProjectIconProps {
  workspacePath: string
  className?: string
  fallbackIcon?: ComponentType<{ className?: string; weight?: 'regular' | 'bold' }>
}

/**
 * A workspace's icon, or the fallback. The lookup comes from
 * `WorkspaceIconContext` where the host provides it, so switching sessions
 * leaves every icon be; hosts that only provide `ViewActions` still work.
 */
export function ProjectIcon(props: ProjectIconProps) {
  const lookup = useContext(WorkspaceIconContext)
  return lookup === WORKSPACE_ICONS_UNSET ? (
    <ProjectIconFromViewActions {...props} />
  ) : (
    <ResolvedProjectIcon {...props} resolveWorkspaceIcon={lookup ?? undefined} />
  )
}

function ProjectIconFromViewActions(props: ProjectIconProps) {
  const { resolveWorkspaceIcon } = useViewActions()
  return <ResolvedProjectIcon {...props} resolveWorkspaceIcon={resolveWorkspaceIcon} />
}

function ResolvedProjectIcon({
  workspacePath,
  className,
  fallbackIcon: FallbackIcon = FolderSimpleIcon,
  resolveWorkspaceIcon,
}: ProjectIconProps & { resolveWorkspaceIcon: ViewActions['resolveWorkspaceIcon'] }) {
  let cache = resolveWorkspaceIcon ? iconCaches.get(resolveWorkspaceIcon) : undefined
  if (resolveWorkspaceIcon && !cache) {
    cache = new Map()
    iconCaches.set(resolveWorkspaceIcon, cache)
  }
  const [src, setSrc] = useState<string | null>(() => cache?.get(workspacePath) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    if (cache?.has(workspacePath)) {
      setSrc(cache.get(workspacePath) ?? null)
      return
    }
    setSrc(null)
    void resolveWorkspaceIcon?.(workspacePath)
      .then((dataUrl) => {
        cache?.set(workspacePath, dataUrl)
        if (!cancelled) setSrc(dataUrl)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [workspacePath, resolveWorkspaceIcon, cache])

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        className={cn('h-3.5 w-3.5 shrink-0 rounded-sm object-contain', className)}
        onError={() => setFailed(true)}
      />
    )
  }

  return <FallbackIcon className={cn('h-3.5 w-3.5 shrink-0', className)} weight="regular" />
}
