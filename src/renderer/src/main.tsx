import './styles/globals.css'
import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import App from './App'

const convexUrl = import.meta.env.CONVEX_URL as string
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null

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
