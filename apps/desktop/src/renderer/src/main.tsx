import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider } from 'convex/react'
import App from './App'
import { convex } from './lib/convex'

try {
  const stored = localStorage.getItem('openmanager-theme')
  if (stored === 'light') document.documentElement.dataset.theme = 'light'
} catch {
  /* ignore */
}

function Root() {
  if (convex) {
    return (
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    )
  }
  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
