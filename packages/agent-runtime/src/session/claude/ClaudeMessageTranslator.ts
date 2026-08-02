import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BackendEvent, BackendRoute } from '../../backends/Backend.js'
import type { HostDeps } from '../../host.js'
import { object, routeEvent, string } from '../wire.js'

/** What the runtime does with a translated message. `events` are forwarded
 * verbatim; `completed` is the turn-terminal *candidate* the runtime matches
 * against its active dispatch — the translator deliberately does not know
 * which turn is active, because "is this result mine?" is lifecycle state and
 * belongs with the state machine that owns it.
 *
 * `prompt_completed` is therefore emitted by the runtime and not here: a
 * result belonging to a subagent, or arriving late for a turn that already
 * settled, must not tell the UI the user's turn is over. */
export type TranslatedMessage = {
  events: BackendEvent[]
  completed?: { sessionId: string; stopReason?: string; isError: boolean; errorText?: string }
}

/** SDK messages in, `BackendEvent`s out.
 *
 * A class rather than a pure function because almost nothing Claude Code emits
 * is self-contained. Commit 3b gives this object the state that forces it:
 * partial tool-input JSON accumulated across `input_json_delta`s, the
 * content-block index -> block identity map that `stream_event` positions are
 * meaningless without, tool_use_id -> tool_result correlation spanning
 * assistant and user messages, and the subagent (`parent_tool_use_id`) tree.
 * Making it stateful now means 3b adds fields instead of changing every call
 * site's signature.
 *
 * The one rule that outranks everything else here: NEVER throw on an unknown
 * message. `SDKMessage` is a 38-member union today and the CLI adds members in
 * point releases; a translator that throws turns a new informational banner
 * into a dead session. Unknown shapes are logged once and dropped. */
export class ClaudeMessageTranslator {
  constructor(
    private readonly route: () => BackendRoute,
    private readonly log: Pick<HostDeps, 'log'>['log'],
  ) {}

  translate(message: SDKMessage): TranslatedMessage {
    try {
      return this.dispatch(message)
    } catch (error) {
      // A malformed frame must cost one message, not the session. The runtime
      // keeps pumping and the turn still settles on its `result`.
      this.log({
        scope: 'claude',
        level: 'warn',
        message: 'Claude message translation failed',
        data: { type: (message as { type?: unknown }).type, error: `${error}` },
      })
      return { events: [] }
    }
  }

  private dispatch(message: SDKMessage): TranslatedMessage {
    switch (message.type) {
      case 'stream_event':
        return { events: this.streamEvent(message) }
      case 'result':
        return {
          events: [],
          completed: {
            sessionId: message.session_id,
            ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
            isError: message.is_error === true || message.subtype !== 'success',
            ...(message.subtype === 'success'
              ? {}
              : { errorText: message.errors?.join('; ') || message.subtype }),
          },
        }
      default:
        // Everything else — assistant/user messages, tool traffic, hooks,
        // task notifications, permission denials, status banners — is 3b's
        // job. Logged so a live session shows exactly which members of the
        // union are actually in play before the translator is written.
        this.log({
          scope: 'claude',
          level: 'info',
          message: `[sdk] <- ${message.type}`,
          data: { subtype: string(object(message).subtype) },
        })
        return { events: [] }
    }
  }

  /** Assistant text, and only assistant text.
   *
   * `stream_event` carries the raw Anthropic streaming envelope, so the same
   * `content_block_delta` frame delivers assistant prose, thinking, tool input
   * JSON and citations depending on the delta's own `type`. 3a reads exactly
   * one of them; anything else falls through silently rather than being
   * mistranslated into visible message text. */
  private streamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>): BackendEvent[] {
    const event = object(message.event)
    if (string(event.type) !== 'content_block_delta') return []
    const delta = object(event.delta)
    if (string(delta.type) !== 'text_delta') return []
    const text = string(delta.text)
    if (!text) return []
    return [
      routeEvent(this.route(), message.session_id, 'stream', 'agent_message_chunk', {
        content: { type: 'text', text },
      }),
    ]
  }
}
