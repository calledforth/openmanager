import { createFileRoute } from '@tanstack/react-router'
import { SessionWorkspace } from '../components/session-workspace'

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  return <SessionWorkspace sessionId={sessionId} />
}
