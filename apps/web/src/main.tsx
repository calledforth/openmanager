import './zod-config'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WebApp } from './app'
import { createQueryClient } from './query-client'
import { createWebRouter } from './router'
import './styles/theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('OpenManager web root element is missing')

// Folded sidebar rows were once kept here; nothing on web reads them any more.
try {
  window.localStorage.removeItem('openmanager.sidebar.collapsed-workspaces')
} catch {
  // Private mode: there is nothing kept to clear.
}

const queryClient = createQueryClient()
const router = createWebRouter({ queryClient })

createRoot(root).render(
  <StrictMode>
    <WebApp router={router} queryClient={queryClient} />
  </StrictMode>,
)
