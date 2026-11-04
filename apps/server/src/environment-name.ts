import {
  ENVIRONMENT_CHANGED_EVENT,
  ENVIRONMENT_RENAME_CAPABILITY,
  EnvironmentChangedEventSchema,
  EnvironmentNameCommandSchemas,
  EnvironmentNameResponseSchemas,
  type CommandEnvelope,
  type Environment,
  type EventEnvelope,
} from '@openmanager/protocol/node'
import { renameEnvironmentIdentity, type EnvironmentIdentity } from './identity.ts'
import type { Logger } from './logger.ts'

const errorResult = (requestId: string, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code: 'validation' as const, message },
})

/**
 * Renaming the environment. The new name is on disk before anyone is told,
 * then every connection hears it at once, and bootstrap answers with it from
 * then on, so a device that was away reads it when it next connects.
 *
 * Renames run one at a time: two at once would each write the record from
 * the name before them, and the slower write would win whatever was asked
 * last.
 */
export function createEnvironmentNameService(deps: {
  dataDir: string
  identity: () => EnvironmentIdentity
  setIdentity: (identity: EnvironmentIdentity) => void
  /** The environment as clients read it, for the answer and the announcement. */
  environment: () => Environment
  broadcast: (event: EventEnvelope) => void
  log: Logger
}) {
  let queue: Promise<unknown> = Promise.resolve()

  const rename = async (command: CommandEnvelope) => {
    const parsed = EnvironmentNameCommandSchemas[ENVIRONMENT_RENAME_CAPABILITY].safeParse(command)
    if (!parsed.success) {
      const issue = parsed.error.issues.find((item) => item.path.at(-1) === 'label')
      return errorResult(command.requestId, issue?.message ?? 'Invalid rename.')
    }
    const { label } = parsed.data.payload
    const before = deps.identity()
    if (label !== before.label) {
      deps.setIdentity(await renameEnvironmentIdentity(deps.dataDir, before, label))
      deps.log('info', 'environment renamed', { label })
      const environment = deps.environment()
      deps.broadcast(
        EnvironmentChangedEventSchema.parse({
          type: 'event',
          name: ENVIRONMENT_CHANGED_EVENT,
          payload: { environment },
        }),
      )
    }
    return EnvironmentNameResponseSchemas[ENVIRONMENT_RENAME_CAPABILITY].parse({
      type: 'response',
      requestId: command.requestId,
      payload: { environment: deps.environment() },
    })
  }

  return {
    dispatch(command: CommandEnvelope): Promise<unknown> | undefined {
      if (command.name !== ENVIRONMENT_RENAME_CAPABILITY) return undefined
      const next = queue.then(() => rename(command))
      // One failed write must not stop the renames after it.
      queue = next.catch(() => undefined)
      return next
    },
  }
}
