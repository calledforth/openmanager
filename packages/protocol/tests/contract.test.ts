import { describe, expect, it } from 'vitest'
import {
  ClientMessageSchema,
  DurableEventSchema,
  ReplayCommandSchema,
  SubscriptionEventSchema,
  parseReplayResult,
  sameScope,
  type CommandEnvelope,
  type Cursor,
  type DurableEvent,
} from '@openmanager/protocol'
import {
  verifyDuplicateCommandContract,
  verifyGapReplayContract,
  verifyOutOfOrderEventContract,
  type CommandContractSubject,
  type EventContractFixture,
  type EventContractObservation,
  type EventContractSubject,
  type OutOfOrderPolicy,
} from '@openmanager/protocol/contract-tests'
import { proofCommands } from './proof-fixtures.js'
import {
  replayCommand,
  replayCursor,
  replayRecords,
  replayResponse,
  subscriptionEvent,
} from './replay-fixtures.js'

type CommandFault =
  | 'none'
  | 'duplicate-effect'
  | 'settled-eviction'
  | 'unstable-result'
  | 'wrong-correlation'

class ExampleCommandSubject implements CommandContractSubject {
  private effects = 0
  private resultNumber = 0
  private readonly results = new Map<string, Promise<unknown>>()

  constructor(
    private readonly fault: CommandFault,
    private readonly terminal: 'response' | 'error',
  ) {}

  effectCount() {
    return this.effects
  }

  dispatch(input: unknown): Promise<unknown> {
    const command = ClientMessageSchema.parse(input)
    const existing = this.results.get(command.requestId)
    if (existing && this.fault === 'unstable-result') {
      return existing.then((result) => ({
        ...(result as { type: 'response'; requestId: string; payload: object }),
        deliveryAttempt: ++this.resultNumber,
      }))
    }
    if (existing && this.fault !== 'duplicate-effect') return existing

    this.effects += 1
    this.resultNumber += 1
    const execution = Promise.resolve().then(() => {
      const requestId = this.fault === 'wrong-correlation' ? 'another-request' : command.requestId
      if (this.terminal === 'error') {
        return {
          type: 'error',
          requestId,
          error: { code: 'conflict', message: 'State changed before the command ran' },
        }
      }
      return {
        type: 'response',
        requestId,
        payload: { effectId: 1 },
      }
    })
    const result =
      this.fault === 'settled-eviction'
        ? execution.finally(() => this.results.delete(command.requestId))
        : execution
    this.results.set(command.requestId, result)
    return result
  }
}

type EventFault = 'none' | 'apply-gap' | 'duplicate-replay' | 'replay-hole'

class ExampleEventSubject implements EventContractSubject {
  private cursor: Cursor
  private readonly applied: DurableEvent[] = []
  private readonly buffered = new Map<number, DurableEvent>()

  constructor(
    initialCursor: Cursor,
    private readonly policy: OutOfOrderPolicy,
    private readonly fault: EventFault = 'none',
  ) {
    this.cursor = initialCursor
  }

  observe(): EventContractObservation {
    return { cursor: this.cursor, applied: this.applied }
  }

  deliverLive(input: unknown): void {
    const message = SubscriptionEventSchema.parse(input)
    this.accept(message.payload.record)
  }

  deliverReplay(commandInput: unknown, resultInput: unknown): void {
    const command = ReplayCommandSchema.parse(commandInput)
    const result = parseReplayResult(command, resultInput)
    if (result.type === 'error' || result.payload.mode !== 'replay') {
      throw new Error('Example consumer expected a replay response')
    }

    const records = this.fault === 'replay-hole' ? result.payload.events.slice(1) : result.payload.events
    if (this.fault === 'duplicate-replay') {
      for (const record of records) this.appendUnchecked(record)
      for (const record of this.buffered.values()) this.appendUnchecked(record)
      this.buffered.clear()
      return
    }
    for (const record of records) this.accept(record)
  }

  private accept(input: unknown): void {
    const record = DurableEventSchema.parse(input)
    if (!sameScope(record.cursor.scope, this.cursor.scope) || record.cursor.epoch !== this.cursor.epoch) {
      throw new Error('Event belongs to another stream')
    }
    if (record.cursor.sequence <= this.cursor.sequence) return
    if (record.cursor.sequence === this.cursor.sequence + 1) {
      this.appendUnchecked(record)
      this.drainBuffered()
      return
    }
    if (this.fault === 'apply-gap') {
      this.appendUnchecked(record)
      return
    }
    if (this.policy === 'resequence') {
      this.buffered.set(record.cursor.sequence, record)
      return
    }
    throw new Error('Sequence gap')
  }

  private appendUnchecked(record: DurableEvent): void {
    this.applied.push(record)
    this.cursor = record.cursor
  }

  private drainBuffered(): void {
    let next = this.buffered.get(this.cursor.sequence + 1)
    while (next) {
      this.buffered.delete(next.cursor.sequence)
      this.appendUnchecked(next)
      next = this.buffered.get(this.cursor.sequence + 1)
    }
  }
}

const commandFixture: CommandEnvelope = ClientMessageSchema.parse(
  proofCommands.find((command) => command.name === 'session.create'),
)

const eventFixture: EventContractFixture = {
  initialCursor: replayCursor,
  first: replayRecords[0]!,
  second: replayRecords[1]!,
  firstLive: subscriptionEvent,
  secondLive: {
    ...subscriptionEvent,
    payload: { ...subscriptionEvent.payload, record: replayRecords[1]! },
  },
  replayCommand,
  replayResponse,
}

describe('duplicate-command conformance contract', () => {
  it.each(['response', 'error'] as const)(
    'accepts an idempotent host with a stable %s result',
    async (terminal) => {
      await expect(
        verifyDuplicateCommandContract(
          () => new ExampleCommandSubject('none', terminal),
          commandFixture,
        ),
      ).resolves.toBeUndefined()
    },
  )

  it.each([
    ['duplicate-effect', 'expected one'],
    ['settled-eviction', 'expected one'],
    ['unstable-result', 'identical terminal result'],
    ['wrong-correlation', 'echo the command request ID'],
  ] as const)('detects a %s implementation', async (fault, message) => {
    await expect(
      verifyDuplicateCommandContract(
        () => new ExampleCommandSubject(fault, 'response'),
        commandFixture,
      ),
    ).rejects.toThrow(message)
  })
})

describe('event ordering conformance contract', () => {
  it.each(['resequence', 'reject'] as const)('accepts a client that chooses %s', async (policy) => {
    await expect(
      verifyOutOfOrderEventContract(
        (cursor) => new ExampleEventSubject(cursor, policy),
        eventFixture,
        policy,
      ),
    ).resolves.toBeUndefined()
  })

  it('detects a client that advances across a live sequence gap', async () => {
    await expect(
      verifyOutOfOrderEventContract(
        (cursor) => new ExampleEventSubject(cursor, 'resequence', 'apply-gap'),
        eventFixture,
        'resequence',
      ),
    ).rejects.toThrow('Consumer cursor must be sequence')
  })
})

describe('gap replay conformance contract', () => {
  it.each(['resequence', 'reject'] as const)(
    'recovers a %s client with no duplicates or holes',
    async (policy) => {
      await expect(
        verifyGapReplayContract(
          (cursor) => new ExampleEventSubject(cursor, policy),
          eventFixture,
        ),
      ).resolves.toBeUndefined()
    },
  )

  it.each([
    ['duplicate-replay', 'contiguous, ordered, and unique'],
    ['replay-hole', 'Consumer cursor must be sequence'],
  ] as const)('detects a %s implementation', async (fault, message) => {
    await expect(
      verifyGapReplayContract(
        (cursor) => new ExampleEventSubject(cursor, 'resequence', fault),
        eventFixture,
      ),
    ).rejects.toThrow(message)
  })
})
