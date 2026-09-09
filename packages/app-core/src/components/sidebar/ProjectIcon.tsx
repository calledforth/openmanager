import { useEffect, useState, type ComponentType } from 'react'
import { FolderSimpleIcon } from '@phosphor-icons/react'
import { useViewActions, type ViewActions } from '../../providers/view-actions'
import { cn } from '../../lib/utils'

// Preserve instant remounts without mixing icons from different hosts/environments.
const iconCaches = new WeakMap<
  NonNullable<ViewActions['resolveWorkspaceIcon']>,
  Map<string, string | null>
>()

export function ProjectIcon({
  workspacePath,
  className,
  fallbackIcon: FallbackIcon = FolderSimpleIcon,
}: {
  workspacePath: string
  className?: string
  fallbackIcon?: ComponentType<{ className?: string; weight?: 'regular' | 'bold' }>
}) {
  const { resolveWorkspaceIcon } = useViewActions()
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
