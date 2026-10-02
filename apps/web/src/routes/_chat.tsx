import { createFileRoute, useParams } from '@tanstack/react-router'
import { SessionWorkspace } from '../components/session-workspace'

/**
 * One chat pane for the new-session landing (`/`) and every session
 * (`/sessions/$sessionId`). As separate route components, sending a draft's
 * first message (which moves `/` to the new session's URL) tore the pane down
 * and rebuilt it mid-launch: the composer remounted and, for a frame, the
 * landing came back. Under one layout only the session id changes.
 */
export const Route = createFileRoute('/_chat')({
  component: ChatLayout,
})

function ChatLayout() {
  const { sessionId } = useParams({ strict: false })
  return <SessionWorkspace sessionId={sessionId} />
}
