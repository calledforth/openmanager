import type {
  PlanEntry,
  PlanUpdate,
  SubtaskUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  ToolKind,
} from '@agentpack/contract'
import { subtaskStatusFromTool } from '../../backends/acp/extensions.js'
import { editResultMessage } from '../../protocol/toolCallProjection.js'
import { object, string } from '../wire.js'

/** Claude Code's built-in tools, mapped onto the contract's tool vocabulary.
 *
 * Only the built-ins are listed. MCP tools (`mcp__server__tool`), plugin tools
 * and anything a future CLI adds fall through to `other` rather than being
 * guessed at from the name: a wrong `kind` puts a shell command behind a read
 * icon, which is worse than a neutral one. */
const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Bash: 'execute',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  TodoWrite: 'think',
  Task: 'other',
}

export function claudeToolKind(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? 'other'
}

/** The tool's title is its *name*, deliberately, and this is not an oversight.
 *
 * Both consumers of `ToolCall.title` funnel it straight into the presenter as
 * an identifier, not as prose: `convex-projector.updateTool` and the renderer's
 * `mergeTool` both set `part.tool = tool.title`, and `presentToolPart` then runs
 * `canonicalizeToolName(part.tool)` and `getToolLabels(part.tool)` on it. A
 * pre-rendered sentence ("Read foo.ts") canonicalizes to itself, misses every
 * entry in the label registry and drops the row into the generic branch with no
 * icon and no per-tool layout. Passing `Read` instead hits `TOOL_ICONS.Read`,
 * `labelRegistry.Read.getTitle(input)` — which builds "Read foo.ts" from the
 * `rawInput` we already ship — and the read/edit/terminal renderers.
 *
 * So the honest description of this field for Claude Code is "the key the UI
 * looks the tool up by", and the name is the only value that works. Unknown and
 * MCP tools pass through verbatim, which is exactly what the generic fallback
 * renders. */
export function claudeToolTitle(toolName: string): string {
  return toolName
}

const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const

/** The file a tool is pointed at, when it names one. Used for `locations`,
 * which is what drives "jump to this file" affordances. */
export function claudeToolLocations(input: unknown): ToolCallLocation[] | undefined {
  const value = object(input)
  for (const key of PATH_KEYS) {
    const path = string(value[key])
    if (path) return [{ path }]
  }
  return undefined
}

/** Renderable content derived from a tool's *input*, with no invention.
 *
 * The rule this function follows, and the reason it is not simply "emit a diff
 * for every edit tool": a `{type:'diff'}` item is a claim that `oldText` is what
 * was there before and `newText` is what is there now. We can only make that
 * claim where the input literally contains both halves.
 *
 * - `Edit` carries `old_string`/`new_string`, which are REPLACEMENT SNIPPETS —
 *   not file contents. The pair is still a truthful before/after of the region
 *   being changed, and the renderer diffs the two strings it is given, so the
 *   hunk it draws is accurate. It is a snippet diff, not a file diff.
 * - `MultiEdit` is a list of such pairs applied in order, so edit N's
 *   `old_string` refers to the text as it exists *after* edits 1..N-1. Each pair
 *   is individually truthful; concatenating them into one hunk would not be.
 *   Hence one diff item per edit rather than a synthesized whole-file patch.
 * - `Write` gives the new contents and says nothing about what the file held
 *   before — it overwrites existing files as readily as it creates new ones.
 *   `oldText: null` would assert "this file did not exist", which is a lie
 *   whenever it did. So the written body is presented as plain content.
 * - `NotebookEdit` gives `new_source` for one cell with no before-image, for the
 *   same reason: content, not diff.
 *
 * We deliberately do NOT read the file off disk to manufacture the missing
 * half. By the time this runs the edit may already have been applied, so the
 * "before" we would read is the "after". */
export function claudeToolContentFromInput(
  toolName: string,
  input: unknown,
): ToolCallContent[] | undefined {
  const value = object(input)
  const path = string(value.file_path) ?? string(value.notebook_path) ?? ''

  if (toolName === 'Edit') {
    const oldText = string(value.old_string)
    const newText = string(value.new_string)
    if (!path || oldText === undefined || newText === undefined) return undefined
    return [{ type: 'diff', path, oldText, newText }]
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(value.edits) ? value.edits : []
    const items = edits.flatMap((raw): ToolCallContent[] => {
      const edit = object(raw)
      const oldText = string(edit.old_string)
      const newText = string(edit.new_string)
      if (oldText === undefined || newText === undefined) return []
      return [{ type: 'diff', path, oldText, newText }]
    })
    return items.length > 0 ? items : undefined
  }

  if (toolName === 'Write') {
    const text = string(value.content)
    if (text === undefined) return undefined
    return [{ type: 'content', content: { type: 'text', text } }]
  }

  if (toolName === 'NotebookEdit') {
    const text = string(value.new_source)
    if (text === undefined) return undefined
    return [{ type: 'content', content: { type: 'text', text } }]
  }

  return undefined
}

/** Claude Code's tools whose result text can quote what they wrote. */
const EDIT_RESULT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** The text of a tool result: a string, or the text of its text blocks. */
function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content.flatMap((raw) => {
    const block = object(raw)
    const text = string(block.type) === 'text' ? string(block.text) : undefined
    return text === undefined ? [] : [text]
  })
  return texts.length > 0 ? texts.join('\n') : undefined
}

/** An edit tool's result reduced to its one-line message, never what was written.
 *
 * Claude Code's edit results quote the edit itself, live-verified against the
 * bundled CLI (agent-sdk 0.3.220):
 * - NotebookEdit answers `Updated cell <id> with <new_source>` (and
 *   `Inserted cell ... with ...`): the whole cell source.
 * - A failed Edit answers `String to replace not found in file.\nString:
 *   <old_string>`, and the "Found N matches" error ends the same way, both
 *   inside `<tool_use_error>`.
 * - Older CLIs followed a successful Edit or Write with a `cat -n` snippet,
 *   and MultiEdit lists each replacement after its first line.
 *
 * So the first line is kept, a quoted `String:` is cut off, and a notebook
 * message stops before ` with `. Any other tool's result passes untouched.
 * Undefined when an edit result has no text at all. */
export function claudeEditResultBody(toolName: string | undefined, content: unknown): unknown {
  if (!toolName || !EDIT_RESULT_TOOLS.has(toolName)) return content
  const text = resultText(content)
  if (text === undefined) return undefined
  const message = editResultMessage(text)
  // A notebook message that is not one of the known shapes still stops
  // before what it says the cell now holds.
  return toolName === 'NotebookEdit' ? message.split(' with ')[0]! : message
}

/** Tools whose structured result is a file patch. */
const PATCH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/** What Claude Code's structured tool result (`tool_use_result`, the tool's
 * own Output object) says that the model-visible text does not.
 *
 * - Lines changed, for the edit tools only, and only as Claude Code reported
 *   them: `gitDiff.additions`/`deletions` when it computed a git diff, else the
 *   `+`/`-` lines of its `structuredPatch`. Nothing is diffed here; a result
 *   without either reports nothing.
 * - `interrupted` on a `Bash` result: the command was stopped, not failed. */
export function claudeToolResultExtras(
  toolName: string | undefined,
  result: unknown,
): Pick<ToolCallUpdate, 'lineChanges' | 'outcome'> {
  const value = object(result)
  const extras: Pick<ToolCallUpdate, 'lineChanges' | 'outcome'> = {}
  if (toolName === 'Bash' && value.interrupted === true) extras.outcome = 'cancelled'
  if (!toolName || !PATCH_TOOLS.has(toolName)) return extras
  const gitDiff = object(value.gitDiff)
  const additions = gitDiff.additions
  const deletions = gitDiff.deletions
  if (isCount(additions) && isCount(deletions)) {
    extras.lineChanges = { added: additions, removed: deletions }
    return extras
  }
  if (!Array.isArray(value.structuredPatch)) return extras
  let added = 0
  let removed = 0
  for (const hunk of value.structuredPatch) {
    const lines = object(hunk).lines
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  extras.lineChanges = { added, removed }
  return extras
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/** `TodoWrite`'s input is the whole todo list, re-sent in full on every call, so
 * each one is a complete `plan_update` snapshot rather than an increment.
 *
 * Returns undefined for anything that is not a recognisable todo array — an
 * unparsed partial input, or a future shape — because emitting an empty plan
 * would blank the user's visible checklist. */
export function planUpdateFromTodoWrite(input: unknown): PlanUpdate | undefined {
  const todos = object(input).todos
  if (!Array.isArray(todos)) return undefined
  const entries = todos.flatMap((raw): PlanEntry[] => {
    const todo = object(raw)
    const content = string(todo.content) ?? string(todo.activeForm)
    if (!content) return []
    const status = string(todo.status)
    return [
      {
        content,
        // Claude Code has no priority concept on todos; claiming one would be
        // invented data, and `medium` is the contract's neutral value.
        priority: 'medium',
        status: (PLAN_STATUSES.has(status ?? '') ? status : 'pending') as PlanEntry['status'],
      },
    ]
  })
  return { entries }
}

/** The `Task` tool is Claude Code's subagent delegation, and the only tool that
 * becomes a `SubtaskUpdate` instead of a tool row.
 *
 * Shaped as a `SubtaskAdapter['fromToolCall']` so it plugs into exactly the
 * tracking `AcpSessionRuntimeImpl.subtaskFromTool` already implements: the first
 * non-undefined return claims the toolCallId, and every later update for that id
 * is routed back through here (with `tracked: true`) so a status-only update
 * still lands on the subtask row rather than resurrecting a raw tool row.
 *
 * `tracked` is what makes the update phase work at all: by then the title is
 * still `Task` but the raw input may not be repeated, so identification has to
 * come from the id we already claimed. */
export function subtaskFromClaudeTool(
  tool: ToolCall | ToolCallUpdate,
  context: { phase: 'call' | 'update'; tracked: boolean },
): SubtaskUpdate | undefined {
  if (!tool.toolCallId) return undefined
  if (tool.title !== 'Task' && !context.tracked) return undefined
  const input = object(tool.rawInput)
  const description = string(input.description)
  const prompt = string(input.prompt)
  const subagentType = string(input.subagent_type)
  const status = subtaskStatusFromTool(tool.status)
  return {
    taskId: tool.toolCallId,
    title: 'Task',
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(string(input.model) ? { modelId: string(input.model) } : {}),
    ...(status ? { status, statusSource: 'task_event' as const } : {}),
  }
}
