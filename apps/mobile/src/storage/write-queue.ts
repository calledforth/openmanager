/**
 * One serial queue for every write to the phone's stores, AsyncStorage and
 * SecureStore alike. Writes run one at a time in the order they were asked
 * for, so the persisted state only ever passes through states the in-memory
 * one did, in the same order. That is what lets the credential and the
 * registry be written as separate steps (see `phone-storage.ts`) without a
 * crash between them leaving a credential nobody can find.
 *
 * Two coalescing writes to the same key with nothing between them collapse
 * into the later one: the state after both is the state after the second, and no
 * other key's write is moved across it, so no crash point is invented. A
 * burst of route-health updates therefore costs at most one write in flight
 * and one waiting.
 */
export type WriteJob = {
  /** Identity for coalescing, such as `async:<key>` or `secure:<key>`. */
  key: string
  run: () => Promise<void>
  /**
   * Whether a later write to the same key, queued straight after this one,
   * may take its place. A write whose outcome matters (its `onDone` or
   * `onError` keeps state) says no.
   */
  coalesce: boolean
  /** Called when the write fails. The queue carries on with the next one. */
  onError?: (cause: unknown) => void
  /** Called after the write succeeded. */
  onDone?: () => void
}

export type WriteQueue = {
  enqueue(job: WriteJob): void
  /** Resolves once every write asked for so far, and any they queue, has run. */
  drained(): Promise<void>
  /** Writes not yet finished, the one running included. For tests. */
  readonly size: number
}

export function createWriteQueue(): WriteQueue {
  const waiting: WriteJob[] = []
  let running: Promise<void> | null = null
  let idleWaiters: Array<() => void> = []

  const pump = async () => {
    for (;;) {
      const job = waiting.shift()
      if (!job) break
      let failed = false
      let failure: unknown
      try {
        await job.run()
      } catch (cause) {
        failed = true
        failure = cause
      }
      // A callback that throws must not stop the writes after it.
      try {
        if (failed) job.onError?.(failure)
        else job.onDone?.()
      } catch {
        /* reported by nobody; the next write still runs */
      }
    }
    running = null
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  return {
    enqueue(job) {
      // Only the tail, and only while it waits: anything between two writes
      // to the same key keeps its place relative to both.
      const tail = waiting[waiting.length - 1]
      if (tail && tail.key === job.key && tail.coalesce && job.coalesce) {
        waiting[waiting.length - 1] = job
      } else waiting.push(job)
      if (!running) running = pump()
    },
    drained() {
      if (!running) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },
    get size() {
      return waiting.length + (running ? 1 : 0)
    },
  }
}
