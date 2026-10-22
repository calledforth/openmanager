import { ComposerSurface } from './ComposerSurface'
import { ThreadBridge } from './thread-port'
import type { ComposerUi } from './ui-state'
import { useLiveComposerModel } from './useLiveComposerModel'

/**
 * The composer of a live session (or, through the same shared logic, a new
 * session's draft), bound to the shared providers exactly as web's
 * `MessageInput` is: picks from `deriveComposerControls` and the composer
 * state's setters, the draft in the shared draft store, images through the
 * environment's uploader, the send and interrupt through the active thread,
 * and the pending interaction from the interaction providers. Nothing it
 * shows is decided on the phone.
 */
export function LiveComposer({
  sessionId,
  ui,
  contextName,
}: {
  /** The session the page shows; until the client has it open, nothing can be sent. */
  sessionId: string
  ui: ComposerUi
  /** The session's project, named in the pulled-up composer's bar. */
  contextName: string | null
}) {
  const { model, port } = useLiveComposerModel(sessionId)
  return (
    <>
      <ThreadBridge port={port} />
      <ComposerSurface model={model} ui={ui} contextName={contextName} />
    </>
  )
}
