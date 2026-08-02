import type {
  ExtensionOutcome,
  PermissionCancellationReason,
  PlanReviewOutcome,
  ProviderId,
  QuestionOutcome,
} from '@agentpack/contract'

/** How long a parked interaction may wait for a human before it is cancelled.
 *
 * This is not a nicety. ACP requests block the provider's turn, so a request
 * nobody answers would hold a CLI process open indefinitely; and providers that
 * park an interaction inside an SDK callback impose no deadline of their own at
 * all — the Claude Code SDK will happily leave a permission callback suspended
 * forever — which makes this timeout the ONLY thing between an unanswered
 * question and a session that never finishes its turn. */
export const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000

/** What kind of answer a parked request is waiting for. The kind decides which
 * resolution event the runtime emits, which decides which pending row the
 * desktop host, Convex and mobile clear. */
export type InteractionKind = 'extension' | 'question' | 'plan_review'

/** The user's answer in the vocabulary of the interaction, as opposed to the
 * provider-native wire response that `respond` hands back to the transport.
 * Consumers persisting the result (the Convex projector) read this instead of
 * sniffing the shape of somebody else's payload. `extension` interactions carry
 * only an opaque response, so they have no resolution. */
export type InteractionResolution =
  | { kind: 'question'; outcome: QuestionOutcome }
  | { kind: 'plan_review'; outcome: PlanReviewOutcome }

/** Reuses the extension vocabulary: `responded` with the transport's payload,
 * or `cancelled` with the permission cancellation reasons (timeout,
 * session_closed, tool_cancelled, runtime_disposed, user). */
export type InteractionOutcome = ExtensionOutcome

type Pending = {
  kind: InteractionKind
  providerId: ProviderId
  threadId: string
  workspaceId?: string
  sessionId: string
  /** The ACP `_ext` method that parked this request. Absent for providers that
   * park an interaction without a wire method — an SDK permission callback has
   * no method name to report. */
  method?: string
  resolve: (outcome: InteractionOutcome) => void
  timer: NodeJS.Timeout
}

export type InteractionSettlement = {
  requestId: string
  kind: InteractionKind
  providerId: ProviderId
  threadId: string
  workspaceId?: string
  sessionId: string
  method?: string
  outcome: InteractionOutcome
  resolution?: InteractionResolution
}

/** The one place a request that needs a human answer is parked, whatever asked
 * for it and however the answer gets back to the provider.
 *
 * Modelled on `PermissionBroker`, which was already transport-agnostic: every
 * pending record carries its own provider/thread/workspace/session, so
 * responding needs no lookup table and a dying thread settles only its own
 * requests. The guarantees callers depend on:
 *
 * - request ids are globally unique (uuids minted by the caller), so one map
 *   serves every provider and every session;
 * - settlement is strictly one-shot — the record is deleted before `resolve`
 *   runs, so a late user answer, a timeout and a process death racing each
 *   other produce exactly one outcome and exactly one settlement callback;
 * - nothing is ever left parked: `cancelThread`, `settleThread`,
 *   `settleProvider` and `settleAll` sweep by scope, and the timeout catches
 *   whatever none of them covered.
 *
 * This was `ExtensionBroker`, which hard-coded ACP's `_ext` method name and
 * reported every settlement as `extension_resolved`. Questions and plan reviews
 * do not necessarily arrive over `_ext` — a provider can raise them from an SDK
 * callback — and a host that clears its pending rows on `extension_resolved`
 * leaves those rows pending forever. Hence `kind`, and hence the distinct
 * `question_resolved` / `plan_review_resolved` events derived from it. */
export class InteractionBroker {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly onSettle?: (settlement: InteractionSettlement) => void) {}

  add(requestId: string, args: Omit<Pending, 'timer'>, timeoutMs = INTERACTION_TIMEOUT_MS): void {
    const timer = setTimeout(
      () => this.settleOne(requestId, { outcome: 'cancelled', reason: 'timeout' }),
      timeoutMs,
    )
    timer.unref?.()
    this.pending.set(requestId, { ...args, timer })
  }

  /** Settle with the provider-native wire response. `resolution` is the same
   * answer in the interaction's own vocabulary, for kinds that have one. */
  respond(requestId: string, response: unknown, resolution?: InteractionResolution): boolean {
    return this.settleOne(requestId, { outcome: 'responded', response }, resolution)
  }

  /** Cancel ONE parked request, for a provider that learns a single interaction
   * is dead without its thread being dead.
   *
   * The SDK backends need this: a `canUseTool` callback carries its own
   * `AbortSignal`, so an individual tool call can be abandoned (a hook denied
   * it, the model changed its mind, a nested agent was stopped) while the turn
   * and every other parked request continue. Without it the record would sit
   * until the five-minute timeout. Returns false when nothing was pending,
   * which is how a losing race reports itself: `settleOne` deletes before it
   * resolves, so an abort and a user answer arriving together still produce
   * exactly one settlement. */
  cancel(requestId: string, reason: PermissionCancellationReason = 'tool_cancelled'): boolean {
    return this.settleOne(requestId, { outcome: 'cancelled', reason })
  }

  cancelThread(providerId: ProviderId, threadId: string): void {
    this.settle('tool_cancelled', providerId, threadId)
  }

  /** See `PermissionBroker.rekeyThread`: a `create_session` rebind renames the
   * thread every pending record here is tagged with. */
  rekeyThread(
    providerId: ProviderId,
    from: string,
    to: string,
    workspaceId: string | undefined,
  ): void {
    if (from === to) return
    for (const request of this.pending.values()) {
      if (request.providerId !== providerId || request.threadId !== from) continue
      request.threadId = to
      if (workspaceId !== undefined) request.workspaceId = workspaceId
    }
  }

  /** The thread's process is gone. Distinct from `cancelThread`, which reports
   * `tool_cancelled` because a user asked for it. */
  settleThread(providerId: ProviderId, threadId: string): void {
    this.settle('session_closed', providerId, threadId)
  }

  settleProvider(providerId: ProviderId): void {
    this.settle('session_closed', providerId)
  }

  settleAll(): void {
    this.settle('runtime_disposed')
  }

  private settle(
    reason: PermissionCancellationReason,
    providerId?: ProviderId,
    threadId?: string,
  ): void {
    for (const [id, request] of this.pending) {
      if (providerId && request.providerId !== providerId) continue
      if (threadId && request.threadId !== threadId) continue
      this.settleOne(id, { outcome: 'cancelled', reason })
    }
  }

  private settleOne(
    requestId: string,
    outcome: InteractionOutcome,
    resolution?: InteractionResolution,
  ): boolean {
    const request = this.pending.get(requestId)
    if (!request) return false
    clearTimeout(request.timer)
    this.pending.delete(requestId)
    request.resolve(outcome)
    // A cancellation means the same thing in every vocabulary, so it is
    // synthesized here rather than demanded from whoever swept the request —
    // a timeout and a dying process have nobody to supply one.
    const settled = resolution ?? cancellationResolution(request.kind, outcome)
    this.onSettle?.({
      requestId,
      kind: request.kind,
      providerId: request.providerId,
      threadId: request.threadId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      ...(request.method !== undefined ? { method: request.method } : {}),
      outcome,
      ...(settled ? { resolution: settled } : {}),
    })
    return true
  }
}

function cancellationResolution(
  kind: InteractionKind,
  outcome: InteractionOutcome,
): InteractionResolution | undefined {
  if (kind === 'extension' || outcome.outcome !== 'cancelled') return undefined
  const cancelled = {
    outcome: 'cancelled' as const,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  }
  return kind === 'question'
    ? { kind: 'question', outcome: cancelled }
    : { kind: 'plan_review', outcome: cancelled }
}
