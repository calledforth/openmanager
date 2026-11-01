import type { Cursor } from '@openmanager/protocol'

/**
 * What a client does with one frame of a scope, given the cursor it holds
 * (docs/sync-foundations.md §5.2): apply it, drop it as older than what is
 * on screen, or start a recovery from the cursor, holding the frame until
 * the answer is applied.
 */
export type Placement = 'apply' | 'drop' | 'recover'

/**
 * The durable-record table. With no cursor yet (a scope subscribed without
 * a replay) there is nothing to compare: the first record applies and
 * becomes the cursor.
 *
 * | Record                         | Action  |
 * | ------------------------------ | ------- |
 * | same epoch, `seq <= C.seq`     | drop    |
 * | same epoch, `seq == C.seq + 1` | apply   |
 * | same epoch, `seq > C.seq + 1`  | recover |
 * | another epoch                  | recover |
 */
export function placeRecord(cursor: Cursor | null, record: Cursor): Placement {
  if (!cursor) return 'apply'
  if (record.epoch !== cursor.epoch) return 'recover'
  if (record.sequence <= cursor.sequence) return 'drop'
  return record.sequence === cursor.sequence + 1 ? 'apply' : 'recover'
}

/**
 * A read answer that states where it read (`session.open`): a client holding
 * the stream past that point has something newer, by the server's numbers.
 * Behind it, or with no position to compare (no cursor, another epoch), the
 * read applies, and the records in between fold over it in their order.
 *
 * | Read at `A`, cursor `C`         | Action |
 * | ------------------------------- | ------ |
 * | no cursor, or another epoch     | apply  |
 * | same epoch, `A.seq >= C.seq`    | apply  |
 * | same epoch, `A.seq < C.seq`     | drop   |
 */
export function placeRead(cursor: Cursor | null | undefined, read: Cursor): 'apply' | 'drop' {
  if (!cursor || read.epoch !== cursor.epoch) return 'apply'
  return read.sequence < cursor.sequence ? 'drop' : 'apply'
}

/**
 * The transient table. A transient happened right after the record at
 * `after`, so it applies only when the cursor is exactly there.
 *
 * | Position                        | Action                                     |
 * | ------------------------------- | ------------------------------------------ |
 * | `Ea == E`, `Sa == C.seq`        | apply                                      |
 * | `Ea == E`, `Sa < C.seq`         | drop: older than the state on screen       |
 * | `Ea == E`, `Sa > C.seq`         | recover: a record it follows is missing    |
 * | `Ea != E`, live                 | recover: the answer settles the epoch      |
 * | `Ea != E`, held during catch-up | drop: the answer's epoch is the one held   |
 *
 * `held` is true for a frame that arrived while a catch-up was in flight
 * and is placed after its answer. With no cursor there is no state to
 * place it in, and it is dropped.
 */
export function placeTransient(cursor: Cursor | null, after: Cursor, held: boolean): Placement {
  if (!cursor) return 'drop'
  if (after.epoch !== cursor.epoch) return held ? 'drop' : 'recover'
  if (after.sequence === cursor.sequence) return 'apply'
  return after.sequence < cursor.sequence ? 'drop' : 'recover'
}
