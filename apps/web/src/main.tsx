import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WebApp } from './app'
import { createQueryClient } from './query-client'
import { createWebRouter } from './router'
import './styles/theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('OpenManager web root element is missing')

const queryClient = createQueryClient()
const router = createWebRouter({ queryClient })

createRoot(root).render(
  <StrictMode>
    <WebApp router={router} queryClient={queryClient} />
  </StrictMode>,
)
