/**
 * The prompts the title model is given, and how its answer becomes a title.
 *
 * Ported from T3 Code's thread titles (MIT). The two prompts share their
 * editorial rules; keep them in step. Rules about looking things up with tools
 * or in git history are gone: here the title model runs with no tools, in an
 * empty folder, and sees only what the prompt carries.
 */

export type TitlePromptInput = {
  /** The first prompt alone, or the conversation laid out by `formatTitleContext`. */
  message: string
  /** Present when renaming a session that already has a title. */
  previousTitle?: string
  /** Names of files attached to the messages in `message`. */
  attachments?: readonly string[]
}

export type GeneratedTitle = {
  title: string
  /** The first prompt did not say what the session is about (a bare link, "fix this"). */
  needsRefinement: boolean
}

/** What a sidebar row shows before it cuts; also the prompt's own limit. */
export const MAX_GENERATED_TITLE_LENGTH = 50
const PROMPT_MESSAGE_BUDGET = 8_000
const ATTACHMENT_BUDGET = 4_000
export const EARLIER_CONTENT_OMITTED = '[Earlier content truncated]\n\n'
const CONTENT_CUT = '\n[Content truncated]\n'

/** The JSON Schema every tool is asked to answer in. */
export const TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    needsRefinement: { type: 'boolean' },
  },
  required: ['title', 'needsRefinement'],
  additionalProperties: false,
} as const

const SHARED_RULES = `- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- Do not claim the work is complete.
- Use attached files as context for what the work is about.`

const INITIAL_PROMPT = `Generate a title that will help the user recognize this coding-agent session weeks later.
Return only JSON with keys title and needsRefinement.
Set needsRefinement to true only if the subject is still unknown, such as an unresolved link, "fix this", or an unexplained attachment. Otherwise set it to false.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
${SHARED_RULES}
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- For reviews, name what is being reviewed and the relevant concern. Avoid generic titles such as "Review PR 123" when the request reveals the subject.
- For research, name the question domain rather than the requested research process.
- Do not copy and truncate the user's message.
- Avoid project names, quotes, labels, filler, and trailing punctuation.
- If the request only points at a link, PR, or issue you cannot see, use the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.`

function regeneratePrompt(previousTitle: string): string {
  return `Regenerate the title for an existing coding-agent session so the user can recognize it weeks later.
The previous title was ${JSON.stringify(previousTitle)}.
Return only JSON with keys title and needsRefinement. Set needsRefinement to false.

Determine the title in this order:
1. Read the USER messages first. Identify the latest explicit durable goal. The original subject remains the subject until the user clearly changes what the session is about.
2. Use ASSISTANT messages to resolve vague links, unnamed code, and discovered product nouns. Do not promote one assistant finding into the session subject unless the user adopts it as a new goal.
3. Compare that subject with the previous title. Preserve accurate scope words, especially when earlier content is truncated. Replace the previous title when it is generic, artifact-based, a completion update, a copy of the first message, or contradicted by the session.
4. Title the durable subject and desired outcome, not the current workflow state.

Editorial rules:
${SHARED_RULES}
- Preserve the umbrella subject when later messages focus on one finding, provider, platform, or implementation detail.
- A session progressing through research, planning, implementation, review, CI, merge, and monitoring has usually not changed subjects.
- Ignore deliverables and operations such as mocks, plans, HTML, branches, PRs, tests, CI, commits, merging, and monitoring unless they are the actual topic.
- Treat final operational follow-ups and assistant completion summaries as weak evidence of subject.
- For reviews, name the reviewed feature or system and its durable concern, not one finding from the review.
- For research, name the question domain rather than the research process.
- Do not copy and truncate a session message.
- Avoid project names, PR numbers, quotes, labels, filler, and trailing punctuation.
- If a linked PR or issue is never explained, use the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.
- Keep the previous title unchanged if it is already accurate. Otherwise return a meaningfully improved title, not a cosmetic paraphrase.

Examples of the distinction:
- A subagent-monitoring review that finds a roster bug remains "Review Subagent Monitoring Risks," not "Roster Bug Review."
- A vague failing-test request later identified as a lazy feed mismatch becomes "Fix Lazy Feed Test," not "Prevent Mobile Feed Regressions."
- A QR-sharing overhaul that ends with CI and merge work remains about QR sharing, not the PR lifecycle.`
}

/** Keep a message's start and end, where the request and its constraints live. */
export function limitTitleMessage(text: string, budget: number): string {
  if (text.length <= budget) return text
  if (budget <= CONTENT_CUT.length) return ''
  const available = budget - CONTENT_CUT.length
  const head = Math.ceil(available / 2)
  const tail = available - head
  return `${text.slice(0, head)}${CONTENT_CUT}${tail > 0 ? text.slice(-tail) : ''}`
}

/** A conversation keeps its newest end, which is where its subject last stood. */
function keepConversationEnd(message: string): string {
  const alreadyCut = message.startsWith(EARLIER_CONTENT_OMITTED)
  const contents = alreadyCut ? message.slice(EARLIER_CONTENT_OMITTED.length) : message
  if (!alreadyCut && contents.length <= PROMPT_MESSAGE_BUDGET) return contents
  return `${EARLIER_CONTENT_OMITTED}${contents.slice(-PROMPT_MESSAGE_BUDGET)}`
}

export function buildTitlePrompt(input: TitlePromptInput): string {
  const attachments = input.attachments?.length
    ? `\n\nAttached files:\n${limitTitleMessage(
        input.attachments.map((name) => `- ${name}`).join('\n'),
        ATTACHMENT_BUDGET,
      )}`
    : ''
  if (input.previousTitle === undefined) {
    const message = limitTitleMessage(input.message, PROMPT_MESSAGE_BUDGET)
    return `${INITIAL_PROMPT}\n\nUser message:\n${message}${attachments}`
  }
  return `${regeneratePrompt(input.previousTitle)}\n\nSession contents:\n${keepConversationEnd(
    input.message,
  )}${attachments}`
}

/**
 * The title in a tool's answer, or undefined when there is none. A tool that
 * could not honour the schema may still answer with the JSON inside prose or a
 * code fence, so the first object that parses with a string `title` wins.
 */
export function parseGeneratedTitle(answer: unknown): GeneratedTitle | undefined {
  const candidate = typeof answer === 'string' ? firstTitleObject(answer) : answer
  if (!candidate || typeof candidate !== 'object') return undefined
  const { title, needsRefinement } = candidate as Record<string, unknown>
  if (typeof title !== 'string') return undefined
  const cleaned = sanitizeTitle(title)
  if (!cleaned) return undefined
  return { title: cleaned, needsRefinement: needsRefinement === true }
}

/** One line, no wrapping quotes, cut to what a row can show. */
export function sanitizeTitle(raw: string): string | undefined {
  const line = raw
    .trim()
    .split(/\r?\n/)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return undefined
  const characters = Array.from(line)
  if (characters.length <= MAX_GENERATED_TITLE_LENGTH) return line
  return `${characters
    .slice(0, MAX_GENERATED_TITLE_LENGTH - 3)
    .join('')
    .trimEnd()}...`
}

function firstTitleObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchingBrace(text, start)
    if (end === -1) continue
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1))
      if (parsed && typeof parsed === 'object' && 'title' in parsed)
        return parsed as Record<string, unknown>
    } catch {
      // Not JSON after all; keep looking.
    }
  }
  return undefined
}

function matchingBrace(text: string, start: number): number {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}
