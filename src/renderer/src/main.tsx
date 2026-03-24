import './styles/globals.css'
import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider } from 'convex/react'
import App from './App'
import { convex } from './lib/convex'

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
