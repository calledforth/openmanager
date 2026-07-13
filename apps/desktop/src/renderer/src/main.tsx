import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider } from 'convex/react'
import App from './App'
import { createConvexClient } from './lib/convex'
import { ThemeProvider } from './providers/theme-provider'
import { ConvexConfigurationRequired } from './components/settings/ConvexSettingsDialog'

try {
  const stored = localStorage.getItem('openmanager-theme')
  if (stored === 'light') document.documentElement.dataset.theme = 'light'
} catch {
  /* ignore */
}

const root = createRoot(document.getElementById('root')!)

async function bootstrap() {
  const config = await window.electronAPI.getRuntimeConfig().catch(() => ({
    convexUrl: '',
    convexSource: 'unset' as const,
    environmentUrlAvailable: false,
  }))

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
        <App />
      </ConvexProvider>
    </StrictMode>,
  )
}

void bootstrap()
