import type { EnvironmentState } from '@openmanager/environment-client'
import type { ModelReroute } from '../providers/composer-provider'

const reroutes = new WeakMap<object, ModelReroute>()

/**
 * The model the session's newest turn moved to, from that turn's last
 * `model_fallback` notice, or null when it ran on the model chosen. Only the
 * newest turn counts: a reroute is the provider's call for one turn, and the
 * next turn starts on the chosen model again. One object per notice, so the
 * composer re-renders only when the answer changes.
 */
export function selectModelReroute(state: EnvironmentState, sessionId: string): ModelReroute | null {
  const threadId = state.sessions[sessionId]?.threadIds[0]
  const thread = threadId ? state.threads[threadId] : undefined
  const turnId = thread?.turns.at(-1)?.turnId
  if (!thread || !turnId) return null
  const notice = thread.notices.findLast(
    (candidate) => candidate.turnId === turnId && candidate.kind === 'model_fallback' && !!candidate.model?.to,
  )
  if (!notice?.model) return null
  let reroute = reroutes.get(notice)
  if (!reroute) {
    reroute = {
      to: notice.model.to,
      ...(notice.model.from ? { from: notice.model.from } : {}),
      ...(notice.detail ? { detail: notice.detail } : {}),
    }
    reroutes.set(notice, reroute)
  }
  return reroute
}
