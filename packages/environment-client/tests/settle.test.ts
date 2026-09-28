import { describe, expect, it } from 'vitest'
import { applyEvent, applySessionList, createInitialState } from '../src/state'
import { createSettleTracker } from '../src/settle'
import { createEnvironmentStore } from '../src/store'
import { SESSION, environmentScope, event } from './fixtures'

const STAND_IN = '2026-09-27T10:00:00.000Z'
const KEPT = '2026-09-27T10:00:00.250Z'

function setup() {
  const store = createEnvironmentStore(
    applySessionList(createInitialState(), [{ ...SESSION, status: 'idle' }]),
  )
  const tracker = createSettleTracker(store, () => STAND_IN)
  let renders = 0
  store.subscribe(() => renders++)
  const settledAt = () => store.getState().sessions[SESSION.sessionId]?.settledAt ?? null
  const echo = (value: string | null) =>
    store.update((state) =>
      applyEvent(
        state,
        tracker.mask(
          event({
            name: 'session.updated',
            scope: environmentScope,
            payload: { sessionId: SESSION.sessionId, settledAt: value },
          }),
        ),
      ),
    )
  return { tracker, settledAt, echo, renders: () => renders }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('settling through the store', () => {
  it('moves the session on the click, before the environment answers', async () => {
    const { tracker, settledAt, echo, renders } = setup()
    const answer = deferred<string | null>()
    const settling = tracker.settle(SESSION.sessionId, true, () => answer.promise)
    expect(settledAt()).toBe(STAND_IN)
    expect(renders()).toBe(1)

    // Its own echo, arriving first, neither moves it nor renders.
    echo(KEPT)
    expect(settledAt()).toBe(STAND_IN)
    expect(renders()).toBe(1)

    answer.resolve(KEPT)
    await settling
    expect(settledAt()).toBe(KEPT)
    expect(renders()).toBe(2)

    // Once nothing is in flight, the environment's word lands as it is.
    echo(null)
    expect(settledAt()).toBeNull()
  })

  it('puts the session back when the environment refuses', async () => {
    const { tracker, settledAt } = setup()
    const answer = deferred<string | null>()
    const settling = tracker.settle(SESSION.sessionId, true, () => answer.promise)
    expect(settledAt()).toBe(STAND_IN)
    answer.reject(new Error('conflict'))
    await expect(settling).rejects.toThrow('conflict')
    expect(settledAt()).toBeNull()
  })

  it('leaves the session to the latest click while an earlier one is answered', async () => {
    const { tracker, settledAt, echo } = setup()
    const first = deferred<string | null>()
    const second = deferred<string | null>()
    const settling = tracker.settle(SESSION.sessionId, true, () => first.promise)
    const unsettling = tracker.settle(SESSION.sessionId, false, () => second.promise)
    expect(settledAt()).toBeNull()

    // The first click's echo and answer do not pull the session back.
    echo(KEPT)
    first.resolve(KEPT)
    await settling
    expect(settledAt()).toBeNull()

    // The second is refused: back to what the environment last confirmed.
    second.reject(new Error('unavailable'))
    await expect(unsettling).rejects.toThrow('unavailable')
    expect(settledAt()).toBe(KEPT)
  })
})
