import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider } from 'convex/react'
import App from './App'
import { createConvexClient } from './lib/convex'
import type { RuntimeConfig } from '../../shared/runtime-config'
import { ThemeProvider } from '@openmanager/app-core/providers/theme-provider'
import { ConvexConfigurationRequired } from './components/settings/ConvexSettingsDialog'
import { DesktopEnvironmentClientProvider } from './environment/DesktopEnvironmentClientProvider'
import {
  readStoredBackendOverride,
  resolveEnvironmentClientSelection,
} from './environment/select-backend'

try {
  const stored = localStorage.getItem('openmanager-theme')
  if (stored === 'light' || stored === 'black') document.documentElement.dataset.theme = stored
} catch {
  /* ignore */
}

const root = createRoot(document.getElementById('root')!)

async function bootstrap() {
  const config = await window.electronAPI.getRuntimeConfig().catch((): RuntimeConfig => ({
    convexUrl: '',
    convexSource: 'unset',
    environmentUrlAvailable: false,
    environmentClient: { backend: 'convex', serverUrl: '', credential: '' },
  }))
  // The compatibility adapter or the real WebSocket client, per the flag; see
  // docs/compatibility-adapters.md. The legacy Convex-backed providers under
  // <App /> stay until the views consume the environment client.
  const environmentClient = resolveEnvironmentClientSelection(
    config.environmentClient,
    readStoredBackendOverride(globalThis.localStorage),
  )

  if (!config.convexUrl) {
    root.render(
      <StrictMode>
        <ThemeProvider>
          <ConvexConfigurationRequired />
        </ThemeProvider>
      </StrictMode>,
    )
    return
  }

  const convex = createConvexClient(config.convexUrl)
  root.render(
    <StrictMode>
      <ConvexProvider client={convex}>
        <DesktopEnvironmentClientProvider config={environmentClient} convex={convex}>
          <App />
        </DesktopEnvironmentClientProvider>
      </ConvexProvider>
    </StrictMode>,
  )
}

void bootstrap()
