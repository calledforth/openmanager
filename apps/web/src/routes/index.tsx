import { createFileRoute } from '@tanstack/react-router'
import { SessionWorkspace } from '../components/session-workspace'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return <SessionWorkspace />
}
