import type { ContentBlock, PromptCapabilities, PromptInput } from '@agentpack/contract'

/** What a Claude Code prompt can carry, stated once for both the session and
 * the probe.
 *
 * Static, because there is no handshake to read it off: the Messages API takes
 * inline base64 images and nothing else this contract models. Declared on the
 * probe as well as the session so a user who has never started a Claude thread
 * can still attach a screenshot to their first message — the composer treats
 * only an explicit `false` as a rejection, and an absent answer would leave the
 * attach button in whatever state the last provider left it. */
export const CLAUDE_PROMPT_CAPABILITIES: PromptCapabilities = {
  image: true,
  // Both refused in `claudePromptContent` rather than half-supported.
  audio: false,
  embeddedContext: false,
}

/** The Anthropic content-block shapes this converter produces. Deliberately a
 * local structural type rather than an import of the SDK's `MessageParam`
 * internals: the message is handed to `SDKUserMessage.message`, which is typed
 * against `@anthropic-ai/sdk`'s beta types, and re-exporting those through this
 * package would make every consumer of `@agentpack/runtime` depend on them. */
type ClaudeTextBlock = { type: 'text'; text: string }
type ClaudeImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: ClaudeImageMediaType; data: string }
}
export type ClaudePromptBlock = ClaudeTextBlock | ClaudeImageBlock

/** What the Messages API accepts as an inline image. Anything else is refused
 * here rather than sent: the API rejects an unknown media type mid-turn, which
 * surfaces as an opaque 400 after the user has already watched a prompt start. */
const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type ClaudeImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

const isImageMediaType = (value: string): value is ClaudeImageMediaType =>
  (IMAGE_MEDIA_TYPES as readonly string[]).includes(value)

/** `PromptInput.blocks` in the SDK's content-block shape.
 *
 * `blocks` is the normalized form the host already builds — `job-worker` has
 * resolved Convex attachments into base64 image blocks by the time a prompt
 * reaches a runtime — so this is a pure re-shaping and never does IO.
 *
 * Everything unsupported throws BEFORE the message is pushed onto the input
 * stream. That ordering is the point: the SDK's input is a long-lived stream
 * with no per-message acknowledgement, so a message it cannot represent is not
 * rejected, it is silently mistranslated or dropped inside the CLI, and the
 * turn simply never produces what the user asked about. Failing here fails the
 * `prompt()` call itself, which is a visible, attributable error.
 *
 * A plain `Error` rather than `CapabilityMissingError`: no `CapabilityKey`
 * describes "which prompt content types this provider accepts" — the closest
 * thing is `PromptCapabilities`, which is advertised, not a capability key. */
export function claudePromptContent(prompt: PromptInput): string | ClaudePromptBlock[] {
  // A text-only prompt travels as a bare string, which is what the CLI's own
  // transcript format uses. Wrapping it in a one-element array works too but
  // reads differently in `~/.claude/projects`, and matching the CLI keeps a
  // resumed transcript uniform with the ones it wrote itself.
  const blocks = prompt.blocks.length > 0 ? prompt.blocks : textOnly(prompt.text)
  if (blocks.length === 1 && blocks[0]?.type === 'text') return blocks[0].text

  return blocks.map((block): ClaudePromptBlock => convert(block))
}

function textOnly(text: string): ContentBlock[] {
  return text ? [{ type: 'text', text }] : []
}

function convert(block: ContentBlock): ClaudePromptBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'image') {
    if (!isImageMediaType(block.mimeType))
      throw new Error(
        `Claude Code cannot accept ${block.mimeType} images (supported: ${IMAGE_MEDIA_TYPES.join(', ')})`,
      )
    if (!block.data) throw new Error('Claude Code received an image attachment with no data')
    return { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } }
  }
  if (block.type === 'audio')
    throw new Error('Claude Code cannot accept audio attachments in a prompt')
  // `resource` / `resource_link` are ACP's embedded-context blocks. Claude Code
  // has its own file-reference mechanism (@-mentions resolved by the CLI), so
  // forwarding one as text would either duplicate content the agent can read
  // itself or paste a URI the model cannot follow. Refused rather than guessed.
  throw new Error(`Claude Code cannot accept "${block.type}" prompt content`)
}
