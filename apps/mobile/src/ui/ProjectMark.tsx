import { useContext, useEffect, useState } from 'react'
import { Image } from 'react-native'
import { SvgXml } from 'react-native-svg'
import {
  WORKSPACE_ICONS_UNSET,
  WorkspaceIconContext,
  type ViewActions,
} from '@openmanager/app-core/logic'

import { ProjectSquare } from './ProjectChip'
import { svgOfDataUrl } from './project-icon'

type Lookup = NonNullable<ViewActions['resolveWorkspaceIcon']>

// One cache per lookup, as web's `ProjectIcon` keeps: a remount shows the
// icon at once, and two environments never share one.
const caches = new WeakMap<Lookup, Map<string, string | null>>()

/** The icon a project declares (`workspace.icon`), as a data URL; null when it has none. */
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
 * square in the colour its name fixes. An icon that will not draw falls back
 * to the square too.
 */
export function ProjectMark({
  workspaceId,
  name,
  size = 12,
}: {
  workspaceId: string | null
  name: string
  size?: number
}) {
  const src = useDeclaredIcon(workspaceId)
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) return <ProjectSquare name={name} size={size} />
  const svg = svgOfDataUrl(src)
  if (svg !== undefined) {
    if (svg === null) return <ProjectSquare name={name} size={size} />
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
