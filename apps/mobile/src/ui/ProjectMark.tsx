import { FolderSimpleIcon } from 'phosphor-react-native'
import { useContext, useEffect, useState } from 'react'
import { Image } from 'react-native'
import { SvgXml } from 'react-native-svg'
import {
  SidebarDataContext,
  WORKSPACE_ICONS_UNSET,
  WorkspaceIconContext,
  type ViewActions,
} from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { NoProjectMark } from './NoProjectMark'
import { svgOfDataUrl } from './project-icon'

type Lookup = NonNullable<ViewActions['resolveWorkspaceIcon']>

// One cache per lookup, as web's `ProjectIcon` keeps: a remount shows the
// icon at once, and two environments never share one.
const caches = new WeakMap<Lookup, Map<string, string | null>>()

/** The icon a project declares (`workspace.icon`), as a data URL; null when it has none. */
/**
 * Whether this is the environment's "No project", as its workspace list says.
 * Read here rather than passed in, so every row, chip and header that marks a
 * project marks "No project" too.
 */
function useIsNoProject(workspaceId: string | null): boolean {
  const workspaces = useContext(SidebarDataContext)?.workspaces
  return (
    !!workspaceId &&
    workspaces?.some((workspace) => workspace.path === workspaceId && workspace.scratch) === true
  )
}

function useDeclaredIcon(workspaceId: string | null): string | null {
  const provided = useContext(WorkspaceIconContext)
  const lookup = provided === WORKSPACE_ICONS_UNSET ? null : provided
  let cache = lookup ? caches.get(lookup) : undefined
  if (lookup && !cache) {
    cache = new Map()
    caches.set(lookup, cache)
  }
  const cached = workspaceId && cache?.has(workspaceId) ? cache.get(workspaceId)! : null
  const [loaded, setLoaded] = useState<{ id: string; src: string | null } | null>(null)
  useEffect(() => {
    if (!lookup || !workspaceId || cache?.has(workspaceId)) return
    let live = true
    lookup(workspaceId).then(
      (src) => {
        cache?.set(workspaceId, src)
        if (live) setLoaded({ id: workspaceId, src })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [cache, lookup, workspaceId])
  if (!workspaceId) return null
  return cached ?? (loaded?.id === workspaceId ? loaded.src : null)
}

/**
 * A project's mark: the icon its folder declares, once the environment has
 * said (the server's `workspace.icon`, as web's sidebar shows it), else the
 * folder, as web's `ProjectIcon` falls back to. An icon that will not draw
 * falls back to the folder too. `color` is the folder's; the muted ink
 * unless said.
 */
export function ProjectMark({
  workspaceId,
  size = 12,
  color,
}: {
  workspaceId: string | null
  size?: number
  color?: string
}) {
  const theme = usePhoneTheme()
  const scratch = useIsNoProject(workspaceId)
  const src = useDeclaredIcon(scratch ? null : workspaceId)
  const [failed, setFailed] = useState<string | null>(null)
  if (scratch) return <NoProjectMark size={size} color={color ?? theme.muted} />
  const folder = <FolderSimpleIcon size={size} color={color ?? theme.muted} />
  if (!src || failed === src) return folder
  const svg = svgOfDataUrl(src)
  if (svg !== undefined) {
    if (svg === null) return folder
    return (
      <SvgXml
        xml={svg}
        width={size}
        height={size}
        accessible={false}
        onError={() => setFailed(src)}
      />
    )
  }
  return (
    <Image
      source={{ uri: src }}
      accessible={false}
      resizeMode="contain"
      onError={() => setFailed(src)}
      style={{ width: size, height: size, borderRadius: size / 6 }}
    />
  )
}
