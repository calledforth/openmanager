import { createFileRoute } from '@tanstack/react-router'

/**
 * A new-session draft's page. The `_chat` layout renders the pane, so the
 * blank page (`/`) gets this address with its first text or image without
 * the composer being rebuilt, and the draft's first send moves on to its
 * session the same way.
 */
export const Route = createFileRoute('/_chat/drafts/$draftId')({})
