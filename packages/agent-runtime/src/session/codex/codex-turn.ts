import type { MessagePhase as ChunkPhase, SessionUsage, TokenUsage } from '@agentpack/contract'
import type { MessagePhase, v2 } from '@openmanager/codex-app-server-protocol'

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

type OpenMessage = { phase: MessagePhase | null; streamed: boolean }
type OpenReasoning = { started: boolean; streamed: boolean; lastPart: number }
/** A steer sent into this turn whose `userMessage` Codex has not echoed yet:
 * its words, to know the echo by when it carries no client id. */
type PendingSteer = { steerId: string; text: string }

/** One Codex turn, translated: assistant text, reasoning summaries, and where
 * the messages steered into it landed.
 *
 * Tool items (commands, file changes, MCP calls, …) are CAL-255's and are not
 * translated here; this only notes that they happened. Reasoning arrives as
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

  constructor(
    private readonly emit: (output: CodexTurnOutput) => void,
    /** The thread's cumulative token counts before this turn, when known.
     * Unknown for the first turn a process sees (a resumed thread's history
     * counts too); the turn's first reading supplies it then. */
    private baseline?: v2.TokenUsageBreakdown,
  ) {}

  itemStarted(item: v2.ThreadItem): void {
    switch (item.type) {
      case 'agentMessage':
        this.messages.set(item.id, { phase: item.phase, streamed: false })
        return
      case 'reasoning':
        this.openReasoning(item.id)
        return
      case 'userMessage':
        this.userMessage(item)
        return
      default:
        // Everything CAL-255 will translate.
        return
    }
  }

  /** A message is being steered into this turn: watch for Codex placing it.
   * Recorded before `turn/steer` goes out, because the echo can beat the
   * answer. */
  expectSteer(steerId: string, input: readonly v2.UserInput[]): void {
    this.steers.push({ steerId, text: inputText(input) })
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
   * still waiting; an echo matching no steer is our prompt's, or input this
   * runtime did not send, and is left alone. */
  private userMessage(item: Extract<v2.ThreadItem, { type: 'userMessage' }>): void {
    if (this.steers.length === 0) return
    const index =
      item.clientId !== null
        ? this.steers.findIndex((steer) => steer.steerId === item.clientId)
        : this.steers.findIndex((steer) => steer.text === inputText(item.content))
    if (index === -1) return
    const [steer] = this.steers.splice(index, 1)
    this.emit({ event: 'steer_delivered', data: { steerId: steer!.steerId } })
  }

  agentMessageDelta(params: v2.AgentMessageDeltaNotification): void {
    if (!params.delta) return
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
        const message = this.messages.get(item.id)
        // A message whose deltas never arrived (a short one can come whole)
        // is backfilled from the completed item, so no answer is lost.
        if (!message?.streamed && item.text)
          this.text(item.id, item.text, item.phase ?? message?.phase ?? null)
        this.messages.delete(item.id)
        return
      }
      case 'reasoning': {
        const open = this.openReasoning(item.id)
        if (!open.streamed && item.summary.length > 0)
          this.thought(item.id, item.summary.join('\n\n'))
        this.closeReasoning(item.id)
        return
      }
      case 'userMessage':
        // Its `item/started` placed it already; this only catches an echo
        // whose start was never seen.
        this.userMessage(item)
        return
      default:
        return
    }
  }

  tokenUsageUpdated(usage: v2.ThreadTokenUsage): void {
    // With no baseline yet, the thread's total before this reading's own
    // request is where the turn began.
    this.baseline ??= subtract(usage.total, usage.last)
    this.tokenUsage = usage
  }

  /** The thread's cumulative counts as of the last reading: the next turn's
   * baseline. */
  get threadTotals(): v2.TokenUsageBreakdown | undefined {
    return this.tokenUsage?.total
  }

  /** Close whatever is still open: a turn can end (interrupted, failed) with
   * a reasoning item that never completed, and an open thought would leave
   * the timeline showing "thinking" forever.
   *
   * A steer Codex accepted but never echoed is given back
   * (`steer_withdrawn`), so the host queues it for the next turn. Codex
   * echoes a steer within milliseconds of taking it, even when the turn is
   * interrupted straight after (probed on 0.170), so no echo means it never
   * reached the conversation; running it again is the safe side, losing it
   * is not. */
  finish(): void {
    for (const id of [...this.reasoning.keys()]) this.closeReasoning(id)
    this.messages.clear()
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
