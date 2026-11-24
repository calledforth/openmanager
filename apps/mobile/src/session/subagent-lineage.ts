/**
 * The open chat's subagent tree, read off the environment's state the way
 * web's strip reads it (`buildLineage`, shared), kept apart from the views
 * so the tests read it without React Native.
 */
import {
  buildLineage,
  type Lineage,
  type LineageNode,
  type LineageSession,
} from '@openmanager/app-core/logic'
import type { Subagent } from '@openmanager/protocol'

/** What the lineage needs of the environment's state. */
export interface LineageState {
  sessions: Readonly<Record<string, LineageSession>>
  threads: Readonly<Record<string, { subagents?: readonly Subagent[] } | undefined>>
}

/** Everything a row draws of a node, as one string: two equal ones draw alike. */
const signature = (lineage: Lineage) =>
  lineage.all
    .map((node: LineageNode) => {
      const record = node.subagent
      return [
        node.key,
        node.depth,
        node.sessionId,
        node.status,
        node.waitingOn,
        node.title,
        node.live,
        record?.activity,
        record?.prompt,
        record?.statusReason,
        record?.stoppable,
        record?.startedAt,
        record?.finishedAt,
        record?.stats.durationMs,
      ].join('\u0000')
    })
    .join('\n')

/**
 * A snapshot reader for `useSyncExternalStore`: the lineage under
 * `sessionId`, as the same object while it draws the same, so a streamed
 * token re-renders nothing. The inputs it read are checked first, by
 * reference; a fresh state that draws alike keeps the old lineage too.
 */
export function lineageReader(getState: () => LineageState, sessionId: string): () => Lineage {
  let last: {
    sessions: LineageState['sessions']
    reads: Array<[threadId: string, subagents: readonly Subagent[] | undefined]>
    lineage: Lineage
    signature: string
  } | null = null
  return () => {
    const state = getState()
    if (
      last &&
      last.sessions === state.sessions &&
      last.reads.every(([threadId, subagents]) => state.threads[threadId]?.subagents === subagents)
    ) {
      return last.lineage
    }
    const reads: Array<[string, readonly Subagent[] | undefined]> = []
    const lineage = buildLineage(sessionId, state.sessions, (threadId) => {
      const subagents = state.threads[threadId]?.subagents
      reads.push([threadId, subagents])
      return subagents
    })
    const drawn = signature(lineage)
    if (last && last.signature === drawn) {
      last = { ...last, sessions: state.sessions, reads }
      return last.lineage
    }
    last = { sessions: state.sessions, reads, lineage, signature: drawn }
    return lineage
  }
}
