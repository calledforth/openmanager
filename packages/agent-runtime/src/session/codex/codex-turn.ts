import type { MessagePhase as ChunkPhase, SessionUsage, TokenUsage } from '@agentpack/contract'
import type { MessagePhase, v2 } from '@openmanager/codex-app-server-protocol'

/** What a turn says, in openmanager's terms. The runtime stamps the route. */
export type CodexTurnOutput =
  | {
      event: 'agent_message_chunk'
      data: { content: { type: 'text'; text: string }; phase?: ChunkPhase }
    }
  | {
      event: 'agent_thought_chunk'
      data: { phase: 'start' | 'delta' | 'stop'; content?: { type: 'text'; text: string } }
    }

type OpenMessage = { phase: MessagePhase | null; streamed: boolean }
type OpenReasoning = { started: boolean; streamed: boolean; parts: number }

/** One Codex turn, translated: assistant text and reasoning summaries.
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
  private readonly messages = new Map<string, OpenMessage>()
  private readonly reasoning = new Map<string, OpenReasoning>()
  private tokenUsage: v2.ThreadTokenUsage | undefined
  /** The last non-retrying error Codex reported for this turn. */
  error: v2.TurnError | undefined

  constructor(private readonly emit: (output: CodexTurnOutput) => void) {}

  itemStarted(item: v2.ThreadItem): void {
    switch (item.type) {
      case 'agentMessage':
        this.messages.set(item.id, { phase: item.phase, streamed: false })
        return
      case 'reasoning':
        this.openReasoning(item.id)
        return
      default:
        // Our own `userMessage` echo, and everything CAL-255 will translate.
        return
    }
  }

  agentMessageDelta(params: v2.AgentMessageDeltaNotification): void {
    if (!params.delta) return
    const message = this.messages.get(params.itemId)
    if (message) message.streamed = true
    else this.messages.set(params.itemId, { phase: null, streamed: true })
    this.text(params.delta, message?.phase ?? null)
  }

  reasoningPartAdded(params: v2.ReasoningSummaryPartAddedNotification): void {
    const open = this.openReasoning(params.itemId)
    // Each summary part is its own headline; keep them apart.
    if (open.parts++ > 0) this.thought('\n\n')
  }

  reasoningSummaryDelta(params: v2.ReasoningSummaryTextDeltaNotification): void {
    if (!params.delta) return
    const open = this.openReasoning(params.itemId)
    open.streamed = true
    this.thought(params.delta)
  }

  itemCompleted(item: v2.ThreadItem): void {
    switch (item.type) {
      case 'agentMessage': {
        const message = this.messages.get(item.id)
        // A message whose deltas never arrived (a short one can come whole)
        // is backfilled from the completed item, so no answer is lost.
        if (!message?.streamed && item.text) this.text(item.text, item.phase ?? message?.phase ?? null)
        this.messages.delete(item.id)
        return
      }
      case 'reasoning': {
        const open = this.openReasoning(item.id)
        if (!open.streamed && item.summary.length > 0) this.thought(item.summary.join('\n\n'))
        this.closeReasoning(item.id)
        return
      }
      default:
        return
    }
  }

  tokenUsageUpdated(usage: v2.ThreadTokenUsage): void {
    this.tokenUsage = usage
  }

  /** Close whatever is still open: a turn can end (interrupted, failed) with
   * a reasoning item that never completed, and an open thought would leave
   * the timeline showing "thinking" forever. */
  finish(): void {
    for (const id of [...this.reasoning.keys()]) this.closeReasoning(id)
    this.messages.clear()
  }

  /** This turn's token counts, for `prompt_completed`. */
  get usage(): TokenUsage | undefined {
    const last = this.tokenUsage?.last
    if (!last) return undefined
    return {
      totalTokens: last.totalTokens,
      inputTokens: last.inputTokens,
      outputTokens: last.outputTokens,
      thoughtTokens: last.reasoningOutputTokens,
      cachedReadTokens: last.cachedInputTokens,
      cachedWriteTokens: last.cacheWriteInputTokens,
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
      open = { started: true, streamed: false, parts: 0 }
      this.reasoning.set(id, open)
      this.emit({ event: 'agent_thought_chunk', data: { phase: 'start' } })
    }
    return open
  }

  private closeReasoning(id: string): void {
    if (!this.reasoning.delete(id)) return
    this.emit({ event: 'agent_thought_chunk', data: { phase: 'stop' } })
  }

  /** Codex names each message's phase when it starts (`item/started`):
   * narration while it works (`commentary`) or the answer. Every chunk
   * carries it, so the host keeps the two apart and the timeline folds the
   * narration into the work instead of running it into the answer. */
  private text(text: string, phase: MessagePhase | null): void {
    this.emit({
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text }, ...(phase ? { phase } : {}) },
    })
  }

  private thought(text: string): void {
    this.emit({
      event: 'agent_thought_chunk',
      data: { phase: 'delta', content: { type: 'text', text } },
    })
  }
}
