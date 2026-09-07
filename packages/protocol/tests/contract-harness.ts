import {
  CommandEnvelopeSchema,
  CursorSchema,
  DurableEventSchema,
  ErrorEnvelopeSchema,
  ReplayCommandSchema,
  ResponseEnvelopeSchema,
  SubscriptionEventSchema,
  parseReplayResult,
  sameScope,
  type CommandEnvelope,
  type Cursor,
  type DurableEvent,
  type ReplayCommand,
  type ReplayResponse,
  type SubscriptionEvent,
} from '@openmanager/protocol'

type Awaitable<T> = T | Promise<T>

export interface CommandContractSubject {
  dispatch(command: unknown): Awaitable<unknown>
  effectCount(): Awaitable<number>
}

export type CommandContractSubjectFactory = () => Awaitable<CommandContractSubject>

export interface EventContractObservation {
  cursor: unknown
  applied: readonly unknown[]
}

export interface EventContractSubject {
  deliverLive(message: unknown): Awaitable<void>
  deliverReplay(command: unknown, result: unknown): Awaitable<void>
  observe(): Awaitable<EventContractObservation>
}

export type EventContractSubjectFactory = (initialCursor: Cursor) => Awaitable<EventContractSubject>
export type OutOfOrderPolicy = 'resequence' | 'reject'

export interface EventContractFixture {
  initialCursor: Cursor
  first: DurableEvent
  second: DurableEvent
  firstLive: SubscriptionEvent
  secondLive: SubscriptionEvent
  replayCommand: ReplayCommand
  replayResponse: ReplayResponse
}

export class ContractViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContractViolation'
  }
}

const stableJson = (input: unknown): string => {
  if (Array.isArray(input)) return `[${input.map(stableJson).join(',')}]`
  if (input !== null && typeof input === 'object') {
    return `{${Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`)
      .join(',')}}`
  }
  return JSON.stringify(input)
}

const cloneJson = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T

const failUnless: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new ContractViolation(message)
}

const terminalResult = (command: CommandEnvelope, input: unknown) => {
  const wireResult = cloneJson(input)
  const result = ResponseEnvelopeSchema.or(ErrorEnvelopeSchema).safeParse(wireResult)
  failUnless(result.success, 'Command must return a valid response or error envelope')
  failUnless(
    result.data.requestId === command.requestId,
    'Terminal result must echo the command request ID',
  )
  return wireResult
}

const assertOneEffect = (before: number, after: number) => {
  failUnless(Number.isSafeInteger(before), 'Effect count before dispatch must be a safe integer')
  failUnless(Number.isSafeInteger(after), 'Effect count after dispatch must be a safe integer')
  failUnless(after - before === 1, `Duplicate delivery caused ${after - before} effects; expected one`)
}

const assertSameResult = (left: unknown, right: unknown) => {
  failUnless(
    stableJson(left) === stableJson(right),
    'Duplicate delivery must return an identical terminal result',
  )
}

/**
 * Exercise both duplicate paths a host must support: joining an in-flight
 * command and replaying its settled terminal result.
 */
export async function verifyDuplicateCommandContract(
  createSubject: CommandContractSubjectFactory,
  fixture: unknown,
): Promise<void> {
  const command = CommandEnvelopeSchema.parse(cloneJson(fixture))

  const pending = await createSubject()
  const pendingBefore = await pending.effectCount()
  const pendingFirstPromise = Promise.resolve(pending.dispatch(cloneJson(command)))
  const pendingSecondPromise = Promise.resolve(pending.dispatch(cloneJson(command)))
  const [pendingFirstRaw, pendingSecondRaw] = await Promise.all([
    pendingFirstPromise,
    pendingSecondPromise,
  ])
  const pendingFirst = terminalResult(command, pendingFirstRaw)
  const pendingSecond = terminalResult(command, pendingSecondRaw)
  assertSameResult(pendingFirst, pendingSecond)
  assertOneEffect(pendingBefore, await pending.effectCount())

  const settled = await createSubject()
  const settledBefore = await settled.effectCount()
  const settledFirst = terminalResult(command, await settled.dispatch(cloneJson(command)))
  const settledSecond = terminalResult(command, await settled.dispatch(cloneJson(command)))
  assertSameResult(settledFirst, settledSecond)
  assertOneEffect(settledBefore, await settled.effectCount())
}

const parseObservation = async (subject: EventContractSubject) => {
  const raw = await subject.observe()
  const cursor = CursorSchema.parse(raw.cursor)
  const applied = raw.applied.map((record) => DurableEventSchema.parse(record))
  return { cursor, applied }
}

const assertObservation = async (
  subject: EventContractSubject,
  initialCursor: Cursor,
  expected: readonly DurableEvent[],
) => {
  const observation = await parseObservation(subject)
  const expectedCursor = expected.at(-1)?.cursor ?? initialCursor
  failUnless(
    stableJson(observation.cursor) === stableJson(expectedCursor),
    `Consumer cursor must be sequence ${expectedCursor.sequence}`,
  )
  failUnless(
    stableJson(observation.applied) === stableJson(expected),
    'Applied durable events must be contiguous, ordered, and unique',
  )
}

const parseEventFixture = (fixture: EventContractFixture): EventContractFixture => {
  const initialCursor = CursorSchema.parse(cloneJson(fixture.initialCursor))
  const first = DurableEventSchema.parse(cloneJson(fixture.first))
  const second = DurableEventSchema.parse(cloneJson(fixture.second))
  const firstLive = SubscriptionEventSchema.parse(cloneJson(fixture.firstLive))
  const secondLive = SubscriptionEventSchema.parse(cloneJson(fixture.secondLive))
  const replayCommand = ReplayCommandSchema.parse(cloneJson(fixture.replayCommand))
  const replayResponse = parseReplayResult(
    replayCommand,
    cloneJson(fixture.replayResponse),
  ) as ReplayResponse

  failUnless(first.cursor.sequence === initialCursor.sequence + 1, 'First event must follow cursor')
  failUnless(second.cursor.sequence === first.cursor.sequence + 1, 'Second event must follow first')
  failUnless(
    sameScope(initialCursor.scope, first.cursor.scope) &&
      sameScope(initialCursor.scope, second.cursor.scope),
    'Fixture records must share the initial cursor scope',
  )
  failUnless(
    initialCursor.epoch === first.cursor.epoch && first.cursor.epoch === second.cursor.epoch,
    'Fixture records must share the initial cursor epoch',
  )
  failUnless(
    stableJson(firstLive.payload.record) === stableJson(first) &&
      stableJson(secondLive.payload.record) === stableJson(second),
    'Live fixtures must wrap the corresponding durable records',
  )
  failUnless(replayResponse.type === 'response', 'Replay fixture must be a response')
  failUnless(replayResponse.payload.mode === 'replay', 'Replay fixture must contain replay events')
  failUnless(
    stableJson(replayResponse.payload.events) === stableJson([first, second]),
    'Replay fixture must close the gap with the complete ordered range',
  )

  return {
    initialCursor,
    first,
    second,
    firstLive,
    secondLive,
    replayCommand,
    replayResponse,
  }
}

const settledDelivery = async (delivery: () => Awaitable<void>) => {
  try {
    await delivery()
    return 'accepted' as const
  } catch {
    return 'rejected' as const
  }
}

/** Verify that a live sequence gap is buffered or explicitly rejected. */
export async function verifyOutOfOrderEventContract(
  createSubject: EventContractSubjectFactory,
  rawFixture: EventContractFixture,
  policy: OutOfOrderPolicy,
): Promise<void> {
  const fixture = parseEventFixture(rawFixture)
  const subject = await createSubject(fixture.initialCursor)
  await assertObservation(subject, fixture.initialCursor, [])

  const gapResult = await settledDelivery(() => subject.deliverLive(cloneJson(fixture.secondLive)))
  failUnless(
    policy === 'resequence' ? gapResult === 'accepted' : gapResult === 'rejected',
    `Out-of-order event must be ${policy === 'resequence' ? 'buffered' : 'rejected'}`,
  )
  await assertObservation(subject, fixture.initialCursor, [])

  const contiguousResult = await settledDelivery(() =>
    subject.deliverLive(cloneJson(fixture.firstLive)),
  )
  failUnless(contiguousResult === 'accepted', 'Next contiguous event must be accepted')
  await assertObservation(
    subject,
    fixture.initialCursor,
    policy === 'resequence' ? [fixture.first, fixture.second] : [fixture.first],
  )
}

/**
 * Verify gap recovery from a valid replay range. A buffered/rejected live event
 * and a duplicate delivery after replay must never create duplicate effects.
 */
export async function verifyGapReplayContract(
  createSubject: EventContractSubjectFactory,
  rawFixture: EventContractFixture,
): Promise<void> {
  const fixture = parseEventFixture(rawFixture)
  const subject = await createSubject(fixture.initialCursor)

  await settledDelivery(() => subject.deliverLive(cloneJson(fixture.secondLive)))
  await assertObservation(subject, fixture.initialCursor, [])

  const replayResult = await settledDelivery(() =>
    subject.deliverReplay(cloneJson(fixture.replayCommand), cloneJson(fixture.replayResponse)),
  )
  failUnless(replayResult === 'accepted', 'A valid contiguous replay must be accepted')
  await assertObservation(subject, fixture.initialCursor, [fixture.first, fixture.second])

  await settledDelivery(() => subject.deliverLive(cloneJson(fixture.secondLive)))
  await assertObservation(subject, fixture.initialCursor, [fixture.first, fixture.second])
}
