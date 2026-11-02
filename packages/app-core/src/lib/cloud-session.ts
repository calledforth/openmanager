/** A prompt has to fit in a query string. The docs set no number, so this stays
 * under the 8 KB that servers and proxies commonly accept. */
const MAX_CLOUD_URL_LENGTH = 8_000

/**
 * A new Claude Code cloud session on claude.ai with the prompt prefilled; the
 * repository is picked there. Null when the prompt is too long to carry.
 *
 * A link rather than `claude --cloud`: the CLI only starts a cloud session from
 * an interactive terminal, and refuses under `--print`, which is the mode the
 * SDK drives it in. https://code.claude.com/docs/en/web-quickstart#pre-fill-sessions
 */
export function cloudSessionUrl(prompt: string): string | null {
  const url = `https://claude.ai/code?prompt=${encodeURIComponent(prompt)}`
  return url.length <= MAX_CLOUD_URL_LENGTH ? url : null
}
