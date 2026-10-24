/**
 * Why a write failed decides what the ordered write queue does with it
 * (event-batcher.ts).
 *
 * - **Transient:** the disk is full, the database is busy or locked, I/O
 *   failed, or the error is not one recognised here. The write is kept and
 *   retried first, ahead of everything appended after it, so nothing
 *   overtakes it.
 * - **Refused:** the write itself is wrong for the rows it meets. A
 *   projection's assertion (I2, I3), an event that fails its schema, a
 *   constraint the rows reject. Retrying can only refuse again and would hold
 *   back every write behind it for good, so the queue drops it, reports it
 *   loudly, and lets later writes through. A refusal is a bug in a producer.
 */

/** A projection or repository invariant the write breaks. */
export class ProjectionRefusal extends Error {
  override name = 'ProjectionRefusal'
}

/** SQLite's primary result code for a constraint failure (UNIQUE, FOREIGN KEY, CHECK, RAISE). */
const SQLITE_CONSTRAINT = 19

export function isRefusal(error: unknown): boolean {
  if (error instanceof ProjectionRefusal) return true
  if (error instanceof Error && error.name === 'ZodError') return true
  const errcode = (error as { errcode?: unknown } | null | undefined)?.errcode
  return typeof errcode === 'number' && (errcode & 0xff) === SQLITE_CONSTRAINT
}
