import type {
  MessagePhase as ChunkPhase,
  ProviderNotice,
  SessionUsage,
  TokenUsage,
  TurnOperationKind,
} from '@agentpack/contract'
import type { MessagePhase, v2 } from '@openmanager/codex-app-server-protocol'
import { CodexTools, type CodexToolOutput } from './codex-tools.js'

/** What a turn says, in openmanager's terms. The runtime stamps the route. */
export type CodexTurnOutput =
  | {
      event: 'agent_message_chunk'
      data: { messageId: string; content: { type: 'text'; text: string }; phase?: ChunkPhase }
    }
  | {
      event: 'agent_thought_chunk'
      data: {
        messageId: string
        phase: 'start' | 'delta' | 'stop'
        content?: { type: 'text'; text: string }
      }
    }
  | { event: 'steer_delivered' | 'steer_withdrawn'; data: { steerId: string } }
  /** A review's markers, and a compaction under way and done. */
  | { event: 'provider_notice'; data: ProviderNotice }
  /** The context meter, once a compaction has emptied the window. */
  | { event: 'usage_update'; data: SessionUsage }
  | CodexToolOutput

type OpenMessage = { phase: MessagePhase | null; streamed: boolean }
type OpenReasoning = { started: boolean; streamed: boolean; lastPart: number }
/** A steer sent into this turn whose `userMessage` Codex has not echoed yet:
 * its words, to know the echo by when it carries no client id, and whether
 * Codex has answered its `turn/steer`. */
type PendingSteer = { steerId: string; text: string; answered: boolean }

/** One Codex turn, translated: assistant text, reasoning summaries, where
 * the messages steered into it landed, and its tools (`CodexTools`: commands,
 * file changes, MCP calls, hooks, the plan, …). Reasoning arrives as
 * short headline summaries, and only because every turn asks for
 * `summary: "detailed"`: the raw chain of thought (`item/reasoning/textDelta`,
 * `item.content`) is never sent by OpenAI over this protocol and is dropped
 * on purpose if it ever is. */
export class CodexTurn {
  /** Codex's id for this turn, once `turn/start` or `turn/started` says. */
  turnId: string | undefined
  /** Set when an interrupt was asked for before the turn id was known. */
  interruptRequested = false
  /** Set once `turn/interrupt` has been sent for this turn. */
  interruptSent = false
  private readonly messages = new Map<string, OpenMessage>()
  private readonly reasoning = new Map<string, OpenReasoning>()
  private tokenUsage: v2.ThreadTokenUsage | undefined
  /** The last non-retrying error Codex reported for this turn. */
  error: v2.TurnError | undefined
  /** Steers sent (`turn/steer`) and not yet placed, in the order sent. */
  private readonly steers: PendingSteer[] = []
  /** Steers Codex has placed, held back while a message or thought streams
   * (see `userMessage`). */
  private readonly placed: string[] = []
  /** `userMessage` items already matched or passed over, by id: each echo
   * arrives twice (`item/started`, `item/completed`) and counts once. */
  private readonly echoes = new Set<string>()
  /** Whether the turn's first `userMessage`, the prompt's echo, was seen. */
  private promptEchoed = false
  private readonly tools: CodexTools
  /** A review's working turn: the extra `turn/started` a review emits names
   * it (its `rootTurnId` is the review's turn), and only it can be
   * interrupted. Every item and the `turn/completed` name the review's. */
  workingTurnId: string | undefined
  /** Review and compaction items already shown, by id: each arrives twice
   * (`item/started`, `item/completed`) and counts once. */
  private readonly marked = new Set<string>()
  /** A compaction under way, and whether Codex read the context since it
   * began (it reads it again once the compaction is done). */
  private compaction: { read: boolean } | undefined
  /** Whether a `contextCompaction` item was seen: then the deprecated
   * `thread/compacted` says nothing more. */
  private compactionItems = false
  /** What a review found, as `exitedReviewMode` said: the message Codex
   * sends after it with the same words is not shown twice. */
  private findings: string | undefined
  /** Agent messages not shown, by id: a review's findings sent again. */
  private readonly skipped = new Set<string>()

  constructor(
    private readonly emit: (output: CodexTurnOutput) => void,
    /** The thread's cumulative token counts before this turn, when known.
     * Unknown for the first turn a process sees (a resumed thread's history
     * counts too); the turn's first reading supplies it then. */
    private baseline?: v2.TokenUsageBreakdown,
    /** The operation this turn runs instead of a prompt (`TurnOperation`). */
    readonly operation?: TurnOperationKind,
  ) {
    this.tools = new CodexTools(emit)
  }

  itemStarted(item: v2.ThreadItem): void {
    switch (item.type) {
      case 'agentMessage':
        if (this.isFindingsAgain(item)) return
        this.messages.set(item.id, { phase: item.phase, streamed: false })
        return
      case 'enteredReviewMode':
      case 'exitedReviewMode':
      case 'contextCompaction':
        this.marker(item, 'started')
        return
      case 'reasoning':
        this.openReasoning(item.id)
        return
      case 'userMessage':
        this.userMessage(item)
        return
      default:
        this.tools.itemStarted(item)
        return
    }
  }

  /** A notification about the turn's tools (output, progress, the plan,
   * hooks). False when it is not one. */
  toolNotification(method: string, params: unknown): boolean {
    return this.tools.notification(method, params)
  }

  /** A message is being steered into this turn: watch for Codex placing it.
   * Recorded before `turn/steer` goes out, because the echo can beat the
   * answer. */
  expectSteer(steerId: string, input: readonly v2.UserInput[]): void {
    this.steers.push({ steerId, text: inputText(input), answered: false })
  }

  /** Codex answered the steer's `turn/steer`: it holds the message. */
  steerAnswered(steerId: string): void {
    const steer = this.steers.find((pending) => pending.steerId === steerId)
    if (steer) steer.answered = true
  }

  /** The turn is being closed without Codex's `turn/completed` (an interrupt
   * past its grace). A steer whose `turn/steer` is still unanswered may be
   * with Codex, and given back it would run a second time, so it counts as
   * placed: the side that never sends a message twice. The ids, to log. */
  placeUnansweredSteers(): string[] {
    const unanswered = this.steers.filter((steer) => !steer.answered)
    for (const steer of unanswered) {
      this.steers.splice(this.steers.indexOf(steer), 1)
      this.emit({ event: 'steer_delivered', data: { steerId: steer.steerId } })
    }
    return unanswered.map((steer) => steer.steerId)
  }

  /** `turn/steer` failed: Codex never took the message, so it will never be
   * placed. False when it was already placed or given back, which is the one
   * event that steer gets, so the caller must not report the failure too. */
  forgetSteer(steerId: string): boolean {
    const index = this.steers.findIndex((steer) => steer.steerId === steerId)
    if (index === -1) return false
    this.steers.splice(index, 1)
    return true
  }

  /** Codex echoes every message of a turn as a `userMessage` item, at the
   * point of the turn where it put it. The prompt's echo is the turn's own
   * start and is not shown again (the host already holds the prompt). A
   * steer's echo is where the steered message sits in the turn: right after
   * Codex took it, while a tool may still be running; the model reads it at
   * its next step. The host shows the message there on `steer_delivered`,
   * from its own copy, so the echo's content is never sent on (that would
   * show it twice).
   *
   * The echo is known by `clientId`, the `clientUserMessageId` the steer was
   * sent with (Codex 0.170 echoes it, probed). One with no client id (a
   * recording made without them) is matched by its words to the oldest steer
   * still waiting, never counting the turn's first echo (the prompt's); an
   * echo matching no steer is our prompt's, or input this runtime did not
   * send, and is left alone.
   *
   * Codex takes a steer at once, even while the model is still writing, and
   * the host starts a new run of text after a delivered steer. So while a
   * message or a thought is still streaming, the delivery waits for it to
   * complete: the message stays whole and the steer sits after it, which is
   * also where the model reads it (its next step). */
  private userMessage(item: Extract<v2.ThreadItem, { type: 'userMessage' }>): void {
    if (this.echoes.has(item.id)) return
    this.echoes.add(item.id)
    const first = !this.promptEchoed
    this.promptEchoed = true
    const index =
      item.clientId !== null
        ? this.steers.findIndex((steer) => steer.steerId === item.clientId)
        : first
          ? -1
          : this.steers.findIndex((steer) => steer.text === inputText(item.content))
    if (index === -1) return
    const [steer] = this.steers.splice(index, 1)
    this.placed.push(steer!.steerId)
    this.deliverPlaced()
  }

  /** Report the placed steers, unless a message or thought is still open. */
  private deliverPlaced(force = false): void {
    if (!force && (this.messages.size > 0 || this.reasoning.size > 0)) return
    for (const steerId of this.placed.splice(0))
      this.emit({ event: 'steer_delivered', data: { steerId } })
  }

  agentMessageDelta(params: v2.AgentMessageDeltaNotification): void {
    if (!params.delta || this.skipped.has(params.itemId)) return
    const message = this.messages.get(params.itemId)
    if (message) message.streamed = true
    else this.messages.set(params.itemId, { phase: null, streamed: true })
    this.text(params.itemId, params.delta, message?.phase ?? null)
  }

  reasoningPartAdded(params: v2.ReasoningSummaryPartAddedNotification): void {
    this.enterPart(params.itemId, this.openReasoning(params.itemId), params.summaryIndex)
  }

  /** Each summary part is its own headline; keep them apart. Keyed on the
   * part's index, so a missing `summaryPartAdded` cannot run two together. */
  private enterPart(itemId: string, open: OpenReasoning, index: number): void {
    if (index <= open.lastPart) return
    if (open.lastPart >= 0) this.thought(itemId, '\n\n')
    open.lastPart = index
  }

  reasoningSummaryDelta(params: v2.ReasoningSummaryTextDeltaNotification): void {
    if (!params.delta) return
    const open = this.openReasoning(params.itemId)
    this.enterPart(params.itemId, open, params.summaryIndex)
    open.streamed = true
    this.thought(params.itemId, params.delta)
  }

  itemCompleted(item: v2.ThreadItem): void {
    switch (item.type) {
      case 'agentMessage': {
        if (this.skipped.has(item.id) || (!this.messages.has(item.id) && this.isFindingsAgain(item))) return
        const message = this.messages.get(item.id)
        // A message whose deltas never arrived (a short one can come whole)
        // is backfilled from the completed item, so no answer is lost.
        if (!message?.streamed && item.text)
          this.text(item.id, item.text, item.phase ?? message?.phase ?? null)
        this.messages.delete(item.id)
        this.deliverPlaced()
        return
      }
      case 'reasoning': {
        const open = this.openReasoning(item.id)
        if (!open.streamed && item.summary.length > 0)
          this.thought(item.id, item.summary.join('\n\n'))
        this.closeReasoning(item.id)
        this.deliverPlaced()
        return
      }
      case 'userMessage':
        // Its `item/started` placed it already; this only catches an echo
        // whose start was never seen.
        this.userMessage(item)
        return
      case 'enteredReviewMode':
      case 'exitedReviewMode':
      case 'contextCompaction':
        this.marker(item, 'completed')
        return
      default:
        this.tools.itemCompleted(item)
        return
    }
  }

  /** A review entering and leaving review mode, and a compaction. Each is
   * shown once, at whichever of its `item/started` and `item/completed`
   * comes first, except a compaction, which is under way between the two.
   *
   * - `enteredReviewMode`: the review's first marker, with what it reviews
   *   as Codex put it ("current changes").
   * - `exitedReviewMode`: the second marker, then what the review found as
   *   the turn's answer. Not when the review was stopped: Codex then says it
   *   "failed to output a response", and its next message says why.
   * - `contextCompaction`: "compacting" while it runs, "compacted" once done
   *   (`manual` in a `/compact` turn, else Codex compacted by itself), and
   *   the context meter from Codex's reading of the emptied window. */
  private marker(
    item: Extract<v2.ThreadItem, { type: 'enteredReviewMode' | 'exitedReviewMode' | 'contextCompaction' }>,
    phase: 'started' | 'completed',
  ): void {
    if (item.type === 'contextCompaction') {
      this.compactionItems = true
      if (phase === 'started') {
        if (this.marked.has(`start:${item.id}`)) return
        this.marked.add(`start:${item.id}`)
        this.compaction = { read: false }
        this.notice({ kind: 'compacting', message: 'Compacting the conversation' })
        return
      }
      if (this.marked.has(item.id)) return
      this.marked.add(item.id)
      const read = this.compaction?.read === true
      this.compaction = undefined
      this.compacted()
      const context = this.contextUsage
      if (read && context) this.emit({ event: 'usage_update', data: context })
      return
    }
    if (this.marked.has(item.id)) return
    this.marked.add(item.id)
    const target = item.review.trim()
    if (item.type === 'enteredReviewMode') {
      this.notice({
        kind: 'info',
        message: target ? `Reviewing ${target}` : 'Review started',
        review: { phase: 'started', ...(target ? { target } : {}) },
      })
      return
    }
    this.notice({ kind: 'info', message: 'Review finished', review: { phase: 'finished' } })
    if (!target || this.interruptRequested) return
    this.findings = item.review
    this.text(item.id, item.review, 'final_answer')
  }

  /** `thread/compacted`, deprecated for the `contextCompaction` item: shown
   * only by a Codex that sends no such item. */
  threadCompacted(): void {
    if (this.compactionItems) return
    this.compacted()
  }

  private compacted(): void {
    const manual = this.operation === 'compact'
    this.notice({
      kind: 'compacted',
      message: manual ? 'Conversation compacted' : 'Conversation compacted automatically',
      compaction: { trigger: manual ? 'manual' : 'auto' },
    })
  }

  /** The agent message Codex sends after a review, repeating its findings. */
  private isFindingsAgain(item: Extract<v2.ThreadItem, { type: 'agentMessage' }>): boolean {
    if (this.findings === undefined || item.text !== this.findings) return false
    this.skipped.add(item.id)
    return true
  }

  private notice(notice: ProviderNotice): void {
    this.emit({ event: 'provider_notice', data: notice })
  }

  tokenUsageUpdated(usage: v2.ThreadTokenUsage): void {
    // With no baseline yet, the thread's total before this reading's own
    // request is where the turn began.
    this.baseline ??= subtract(usage.total, usage.last)
    this.tokenUsage = usage
    if (this.compaction) this.compaction.read = true
  }

  /** The thread's cumulative counts as of the last reading: the next turn's
   * baseline. */
  get threadTotals(): v2.TokenUsageBreakdown | undefined {
    return this.tokenUsage?.total
  }

  /** The processes of this turn's commands still running (unified exec).
   * Read before `finish`. */
  runningProcesses(): string[] {
    return this.tools.runningProcesses()
  }

  /** Close whatever is still open: a turn can end (interrupted, failed) with
   * a reasoning item that never completed, and an open thought would leave
   * the timeline showing "thinking" forever.
   *
   * Steers Codex placed are reported now if a stream held them back. One
   * it never echoed is given back (`steer_withdrawn`), so the host queues it
   * for the next turn. Codex echoes a steer within milliseconds of taking
   * it, even when the turn is interrupted straight after (probed on 0.170),
   * so no echo by `turn/completed` means it never reached the conversation;
   * running it again is the safe side, losing it is not. (A turn closed
   * without `turn/completed` settles its unanswered steers first:
   * `placeUnansweredSteers`.)
   *
   * `runsOn`: the turn ended without being stopped (Codex completed it, or
   * it failed), so a command left running with a process of its own runs on
   * in the background, and settles as such (`CodexTools.finish`), as the
   * background tasks list it. Otherwise the server closes what is still
   * open. */
  finish(runsOn = false): void {
    this.tools.finish(!runsOn || this.interruptRequested)
    for (const id of [...this.reasoning.keys()]) this.closeReasoning(id)
    this.messages.clear()
    this.deliverPlaced(true)
    for (const steer of this.steers.splice(0))
      this.emit({ event: 'steer_withdrawn', data: { steerId: steer.steerId } })
  }

  /** This turn's token counts, for `prompt_completed`. */
  get usage(): TokenUsage | undefined {
    const usage = this.tokenUsage
    if (!usage) return undefined
    // Every model request the turn made (a tool loop makes several), not
    // just the last: the thread's totals now, less where the turn began.
    const turn = this.baseline ? subtract(usage.total, this.baseline) : usage.last
    return {
      totalTokens: turn.totalTokens,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      thoughtTokens: turn.reasoningOutputTokens,
      cachedReadTokens: turn.cachedInputTokens,
      cachedWriteTokens: turn.cacheWriteInputTokens,
    }
  }


  /** How full the context window is, for the composer's meter. Absent when
   * Codex did not say how big the window is: a reading without a size is
   * ignored downstream anyway. */
  get contextUsage(): SessionUsage | undefined {
    const usage = this.tokenUsage
    if (!usage?.modelContextWindow) return undefined
    return { used: usage.last.totalTokens, size: usage.modelContextWindow }
  }

  private openReasoning(id: string): OpenReasoning {
    let open = this.reasoning.get(id)
    if (!open) {
      open = { started: true, streamed: false, lastPart: -1 }
      this.reasoning.set(id, open)
      this.emit({ event: 'agent_thought_chunk', data: { messageId: id, phase: 'start' } })
    }
    return open
  }

  private closeReasoning(id: string): void {
    if (!this.reasoning.delete(id)) return
    this.emit({ event: 'agent_thought_chunk', data: { messageId: id, phase: 'stop' } })
  }

  /** Codex names each message's phase when it starts (`item/started`):
   * narration while it works (`commentary`) or the answer. Every chunk
   * carries it, so the host keeps the two apart and the timeline folds the
   * narration into the work instead of running it into the answer.
   *
   * Every chunk also names its item (`messageId`), so the host can keep
   * Codex's item id beside the message or thought it files the chunk under. */
  private text(itemId: string, text: string, phase: MessagePhase | null): void {
    this.emit({
      event: 'agent_message_chunk',
      data: { messageId: itemId, content: { type: 'text', text }, ...(phase ? { phase } : {}) },
    })
  }

  private thought(itemId: string, text: string): void {
    this.emit({
      event: 'agent_thought_chunk',
      data: { messageId: itemId, phase: 'delta', content: { type: 'text', text } },
    })
  }
}

function subtract(a: v2.TokenUsageBreakdown, b: v2.TokenUsageBreakdown): v2.TokenUsageBreakdown {
  const minus = (x: number, y: number) => Math.max(0, x - y)
  return {
    totalTokens: minus(a.totalTokens, b.totalTokens),
    inputTokens: minus(a.inputTokens, b.inputTokens),
    cachedInputTokens: minus(a.cachedInputTokens, b.cachedInputTokens),
    cacheWriteInputTokens: minus(a.cacheWriteInputTokens, b.cacheWriteInputTokens),
    outputTokens: minus(a.outputTokens, b.outputTokens),
    reasoningOutputTokens: minus(a.reasoningOutputTokens, b.reasoningOutputTokens),
  }
}

/** The words of a message, for matching a steer to its echo. */
function inputText(input: readonly v2.UserInput[]): string {
  return input.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n')
}
