import type { Rig, TestClient } from './harness.ts'
import { until } from './harness.ts'

export interface Target {
  sessionId: string
  threadId: string
}

/**
 * Create a session through the client's own API and open it there. It is
 * titled unless `title: null`: an untitled session is named from its first
 * prompt, a `session.updated` that also moves the workspace's recency with
 * no event (WORKSPACE_RECENCY_MIRROR), which only the scenario about that
 * cause should see.
 */
export async function createSession(
  rig: Rig,
  client: TestClient,
  options: {
    title?: string | null
    open?: boolean
    providerId?: string
    /**
     * Wait until the server is quiet, so the provider session has resolved
     * and its runtime stamp (S8's cause) has landed before the fixture goes
     * on. A choice each scripted fixture makes for itself; see the call sites.
     */
    quiet?: boolean
  } = {},
): Promise<Target> {
  const title = options.title === undefined ? 'Scenario' : options.title
  const created = await client.client.commands.createSession({
    environmentId: rig.environmentId,
    workspaceId: rig.workspaceId,
    providerId: options.providerId ?? 'opencode',
    ...(title !== null ? { title } : {}),
  })
  const target = { sessionId: created.session.sessionId, threadId: created.thread.threadId }
  if (options.open !== false) await client.client.commands.openSession(target.sessionId)
  if (options.quiet !== false) await rig.waitQuiet()
  return target
}

/** Send a prompt and return its turn once the fake provider is running it. */
export async function startTurn(
  client: TestClient,
  target: Target,
  text = 'Do the thing',
): Promise<string> {
  const started = await client.client.commands.sendTurn({ ...target, text })
  return started.turn.turnId
}

/** A whole turn the fake provider runs by itself (`setAutoScript` must be set). */
export async function scriptedTurn(
  client: TestClient,
  target: Target,
  text: string,
): Promise<string> {
  const turnId = await startTurn(client, target, text)
  await until(
    () => {
      const turn = client.client
        .getState()
        .threads[target.threadId]?.turns.find((item) => item.turnId === turnId)
      return turn && turn.state !== 'running' && turn.state !== 'waiting'
    },
    `turn ${turnId} to finish`,
    15_000,
  )
  return turnId
}

export function thread(client: TestClient, target: Target) {
  return client.client.getState().threads[target.threadId]
}

export function turnState(client: TestClient, target: Target, turnId: string) {
  return thread(client, target)?.turns.find((turn) => turn.turnId === turnId)?.state
}

/** Wait until the client's view of the thread satisfies `check`. */
export function untilThread(
  client: TestClient,
  target: Target,
  check: (state: NonNullable<ReturnType<typeof thread>>) => boolean,
  what: string,
  timeoutMs = 10_000,
) {
  return until(
    () => {
      const state = thread(client, target)
      return state && check(state) ? state : undefined
    },
    what,
    timeoutMs,
  )
}
