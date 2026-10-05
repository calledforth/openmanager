import { createFileRoute, useParams } from '@tanstack/react-router'
import { SessionWorkspace } from '../components/session-workspace'

/**
 * One chat pane for the new-session landing (`/`), every draft
 * (`/drafts/$draftId`) and every session (`/sessions/$sessionId`). As
 * separate route components, sending a draft's first message (which moves its
 * URL to the new session's) tore the pane down and rebuilt it mid-launch: the
 * composer remounted and, for a frame, the landing came back. Under one
 * layout only the ids change, so the composer keeps its focus and caret when
 * the blank page takes its draft's address too.
 */
export const Route = createFileRoute('/_chat')({
  component: ChatLayout,
})

// No <Outlet />: the child routes only name URLs. A component given to one of
// them would never render; put what it needs in the pane instead.
function ChatLayout() {
  const { sessionId } = useParams({ strict: false })
  return <SessionWorkspace sessionId={sessionId} />
}
