import { createFileRoute } from '@tanstack/react-router'

/** A session. The `_chat` layout renders the pane and opens the session. */
export const Route = createFileRoute('/_chat/sessions/$sessionId')({})
