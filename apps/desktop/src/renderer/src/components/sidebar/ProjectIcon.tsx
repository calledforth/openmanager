import { useEffect, useState, type ComponentType } from 'react'
import { FolderSimpleIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'

const workspaceIconCache = new Map<string, string | null>()
const workspaceIconInflight = new Map<string, Promise<string | null>>()

async function loadWorkspaceIcon(workspacePath: string): Promise<string | null> {
  if (workspaceIconCache.has(workspacePath)) {
    return workspaceIconCache.get(workspacePath) ?? null
  }

  const inflight = workspaceIconInflight.get(workspacePath)
  if (inflight) return inflight

  const resolve =
    typeof window !== 'undefined' && typeof window.electronAPI?.resolveWorkspaceIcon === 'function'
      ? window.electronAPI.resolveWorkspaceIcon(workspacePath)
      : Promise.resolve(null)

  const pending = resolve
    .catch(() => null)
    .then((dataUrl) => {
      workspaceIconCache.set(workspacePath, dataUrl)
      workspaceIconInflight.delete(workspacePath)
      return dataUrl
    })

  workspaceIconInflight.set(workspacePath, pending)
  return pending
}

export function ProjectIcon({
  workspacePath,
  className,
  fallbackIcon: FallbackIcon = FolderSimpleIcon,
}: {
  workspacePath: string
  className?: string
  fallbackIcon?: ComponentType<{ className?: string; weight?: 'regular' | 'bold' }>
}) {
  const [src, setSrc] = useState<string | null>(() => workspaceIconCache.get(workspacePath) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    const cached = workspaceIconCache.get(workspacePath)
    if (cached !== undefined) {
      setSrc(cached)
      return
    }
    setSrc(null)
    void loadWorkspaceIcon(workspacePath).then((dataUrl) => {
      if (!cancelled) setSrc(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [workspacePath])

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
