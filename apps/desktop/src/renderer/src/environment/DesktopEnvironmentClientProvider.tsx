import { useEffect, useState, type ReactNode } from 'react'
import type { ConvexReactClient } from 'convex/react'
import {
  createWebSocketEnvironmentClient,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import type { EnvironmentClientConfig } from '../../../shared/runtime-config'
import { createConvexEnvironmentClient } from './convex-environment-client'
import { createConvexGateway } from './convex-gateway'
import { environmentSocketUrl } from './select-backend'

/**
 * Mounts the desktop's `EnvironmentClient` behind the backend flag: the real
 * WebSocket client against the environment server, or the temporary Convex
 * adapter. Views below see only `EnvironmentClientProvider`; nothing here
 * leaks into them.
 *
 * When Convex is retired this collapses to the WebSocket branch and moves
 * next to the web shell's provider (docs/compatibility-adapters.md).
 */
export function DesktopEnvironmentClientProvider({
  config,
  convex,
  children,
}: {
  config: EnvironmentClientConfig
  /** The React Convex client; required by the `convex` backend only. */
  convex: ConvexReactClient | null
  children: ReactNode
}) {
  // Created inside the effect so StrictMode's replayed setup gets a fresh
  // instance: a disposed client ignores connect() for good.
  const [client, setClient] = useState<EnvironmentClient | null>(null)
  useEffect(() => {
    let cancelled = false
    let created: EnvironmentClient | null = null
    const mount = (next: EnvironmentClient) => {
      created = next
      setClient(next)
      next.connect()
    }
    if (config.backend === 'websocket') {
      // The main process validates the origin, but a local-storage override
      // can select this backend with whatever URL it was given; a bad one
      // must not take the whole renderer down with it.
      let url: string
      try {
        url = environmentSocketUrl(config.serverUrl)
      } catch (error) {
        console.error('[environment-client] Invalid environment server URL', error)
        return
      }
      mount(
        createWebSocketEnvironmentClient({
          url,
          ...(config.credential ? { credential: config.credential } : {}),
        }),
      )
    } else if (convex) {
      void window.electronAPI
        .getClientId()
        .catch(() => null)
        .then((clientId) => {
          if (cancelled) return
          mount(
            createConvexEnvironmentClient({
              convex: createConvexGateway(convex),
              bridge: window.electronAPI,
              clientId: clientId ?? 'desktop',
            }),
          )
        })
    }
    return () => {
      cancelled = true
      created?.dispose()
      setClient((current) => (current === created ? null : current))
    }
  }, [config.backend, config.credential, config.serverUrl, convex])

  return <EnvironmentClientProvider client={client}>{children}</EnvironmentClientProvider>
}
