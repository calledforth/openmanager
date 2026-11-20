import type {
  ContentBlock,
  PlanEntry,
  PlanUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  ToolKind,
  ToolLineChanges,
} from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import { generatedImage, generationFailure, readImageFile, type ImageRead } from './codex-images.js'

/** What Codex's tool work says, in openmanager's terms. The runtime stamps the
 * route. */
export type CodexToolOutput =
  | { event: 'tool_call'; data: ToolCall }
  | { event: 'tool_call_update'; data: ToolCallUpdate }
  | { event: 'tool_call_content'; data: { toolCallId: string; item: ToolCallContent } }
  | { event: 'plan_update'; data: PlanUpdate }

type Item = v2.ThreadItem
type ItemOf<T extends Item['type']> = Extract<Item, { type: T }>

/** The tool names a Codex row carries. Codex names its built-in tools by item
 * type, so the row keeps that name; the presenter reads the item's own fields
 * (`commandActions`, `changes`, the search `action`) to label it. MCP tools
 * keep the name the model calls them by (`mcp__server__tool`), which is also
 * what the presenter knows MCP calls by. */
export const CODEX_TOOL_NAMES = {
  command: 'commandExecution',
  fileChange: 'fileChange',
  webSearch: 'webSearch',
  imageView: 'imageView',
  imageGeneration: 'imageGeneration',
  sleep: 'sleep',
  hook: 'hook',
  hookPrompt: 'hookPrompt',
  plan: 'update_plan',
} as const

/**
 * One turn's tool items, translated into tool calls.
 *
 * Every item that is a tool becomes one row, keyed on Codex's item id: opened
 * by `item/started` (or by its first sight, for an item that only completes),
 * kept live by the item's own notifications, and settled by `item/completed`.
 * Hooks are rows too, keyed on their run. Codex's plan (`turn/plan/updated`)
 * is the todo checklist, `plan_update`, plus a row where the model updated it.
 *
 * Not translated, on purpose:
 * - `functionCallOutput`: the echo of a `toolOutput` a client hands Codex with
 *   `turn/start`, the result of a tool that client ran itself. Openmanager
 *   sends none, and an echo of what a client sent is not work the agent did,
 *   so there is nothing to show.
 * - `turn/diff/updated`: opted out of at `initialize`. Chat carries no diffs;
 *   each file change's paths and line counts come with its own item.
 * - `item/fileChange/outputDelta`: deprecated; Codex no longer sends it.
 * - `plan` items and `item/plan/delta`: plan mode, which is not ported.
 * - Review mode and compaction: not tool calls.
 *
 * Images: an `imageGeneration` is a row whose result is the image Codex
 * saved, and an `imageView` a read whose result is the image the model
 * looked at. Each file is read as soon as the item names it (`codex-images.ts`),
 * since a generated image's file does not last, and goes out as the call's
 * image content, which the environment stores and files in the reply.
 *
 * Subagent items are `CodexSubagents`'s, and never reach this.
 */
export class CodexTools {
  /** Rows opened, by tool call id. */
  private readonly open = new Set<string>()
  /** Rows settled, by tool call id: a late repeat of an item is dropped. */
  private readonly settled = new Set<string>()
  /** What a command was given, kept to add what it was later written, and
   * its process once it has one (a command still running when the turn ends
   * runs on in the background). */
  private readonly commands = new Map<
    string,
    { input: Record<string, unknown>; stdin: string[]; processId: string | null }
  >()
  /** The open row of each hook run, by Codex's run id. The run id may name
   * the handler rather than one firing of it, so each firing gets a row of
   * its own and its completion settles the one it opened. */
  private readonly hookRows = new Map<string, string>()
  private hooks = 0
  private plans = 0
  /** A generated image read when its item first named the saved file, before
   * the item completed, by tool call id. */
  private readonly images = new Map<string, ImageRead>()

  constructor(private readonly emit: (output: CodexToolOutput) => void) {}

  /** `item/started`. False for an item that is not a tool. */
  itemStarted(item: Item): boolean {
    if (item.type === 'functionCallOutput') return true
    if (item.type === 'hookPrompt') {
      this.hookPrompt(item)
      return true
    }
    const call = this.callOf(item)
    if (!call) return false
    this.keepGenerated(item)
    if (this.open.has(call.toolCallId) || this.settled.has(call.toolCallId)) return true
    this.open.add(call.toolCallId)
    if (item.type === 'commandExecution')
      this.commands.set(item.id, {
        input: call.rawInput as Record<string, unknown>,
        stdin: [],
        processId: item.processId,
      })
    this.emit({ event: 'tool_call', data: { ...call, status: 'in_progress' } })
    return true
  }

  /** `item/completed`. False for an item that is not a tool. */
  itemCompleted(item: Item): boolean {
    if (item.type === 'functionCallOutput') return true
    if (item.type === 'hookPrompt') {
      this.hookPrompt(item)
      return true
    }
    const call = this.callOf(item)
    if (!call) return false
    const id = call.toolCallId
    if (this.settled.has(id)) return true
    this.keepGenerated(item)
    const opened = this.open.delete(id)
    this.settled.add(id)
    const result = this.resultOf(item)
    this.images.delete(id)
    const stdin = this.commands.get(id)?.stdin ?? []
    this.commands.delete(id)
    // A command's exit code joins its input: the row reads a call from its
    // input, and the wire has no field of its own for it. How long it ran is
    // the row's `startedAt` to `finishedAt`.
    const rawInput =
      item.type === 'commandExecution'
        ? {
            ...(call.rawInput as Record<string, unknown>),
            ...(stdin.length > 0 ? { stdin } : {}),
            ...(item.exitCode !== null ? { exitCode: item.exitCode } : {}),
          }
        : call.rawInput
    const update: ToolCall = { ...call, rawInput, ...result }
    // An item seen only completed (one that started before this turn was
    // ours, or a kind Codex sends only once) opens and settles at once.
    this.emit(opened ? { event: 'tool_call_update', data: update } : { event: 'tool_call', data: update })
    return true
  }

  /** A notification about the turn's tools. False when it is not one. */
  notification(method: string, params: unknown): boolean {
    switch (method) {
      case 'item/commandExecution/outputDelta':
      case 'item/mcpToolCall/progress': {
        const { itemId, delta, message } = params as { itemId: string; delta?: string; message?: string }
        // Progress is a line of its own; command output is the terminal's text.
        const text = delta ?? (message ? `${message}\n` : '')
        if (text && this.open.has(itemId))
          this.emit({
            event: 'tool_call_content',
            data: { toolCallId: itemId, item: { type: 'content', content: { type: 'text', text } } },
          })
        return true
      }
      case 'item/commandExecution/terminalInteraction':
        this.terminalInteraction(params as v2.TerminalInteractionNotification)
        return true
      case 'item/fileChange/patchUpdated': {
        const { itemId, changes } = params as v2.FileChangePatchUpdatedNotification
        if (this.settled.has(itemId)) return true
        if (this.open.has(itemId))
          this.emit({ event: 'tool_call_update', data: { toolCallId: itemId, ...fileChangeFields(changes) } })
        // A patch that streams can say what it changes before its
        // `item/started`: the row opens on its first word.
        else
          this.itemStarted({ type: 'fileChange', id: itemId, changes, status: 'inProgress' })
        return true
      }
      case 'turn/plan/updated':
        this.planUpdated(params as v2.TurnPlanUpdatedNotification)
        return true
      case 'hook/started':
        this.hookStarted((params as v2.HookStartedNotification).run)
        return true
      case 'hook/completed':
        this.hookCompleted((params as v2.HookCompletedNotification).run)
        return true
      default:
        return false
    }
  }

  /** Read a generated image the moment its item names the saved file: the
   * file is temporary. Once, whichever sight of the item names it first. */
  private keepGenerated(item: Item): void {
    if (item.type !== 'imageGeneration' || this.images.has(item.id) || this.settled.has(item.id)) return
    if (!item.savedPath) return
    this.images.set(item.id, generatedImage(item))
  }

  /** The processes of commands still open: unified-exec commands Codex has
   * not reported ending. Read before `finish`, which forgets them. */
  runningProcesses(): string[] {
    const running: string[] = []
    for (const [id, command] of this.commands)
      if (command.processId && this.open.has(id)) running.push(command.processId)
    return running
  }

  /**
   * The turn ended. A command with a process of its own (unified exec) that
   * is still open runs on in the background: Codex reports no end for it in
   * this turn, and the server would close its row as cancelled, which it was
   * not. So it settles as completed, its output saying it is still running.
   * Not when the turn was stopped: then it reads as the server closes it.
   * Anything else still open is the server's to close.
   */
  finish(stopped: boolean): void {
    if (stopped) return
    for (const [id, command] of this.commands) {
      if (!command.processId || !this.open.has(id)) continue
      this.emit({
        event: 'tool_call_content',
        data: { toolCallId: id, item: textContent(BACKGROUND_NOTE) },
      })
      this.open.delete(id)
      this.settled.add(id)
      const rawInput = command.stdin.length > 0 ? { ...command.input, stdin: command.stdin } : command.input
      this.emit({ event: 'tool_call_update', data: { toolCallId: id, status: 'completed', rawInput } })
    }
    this.commands.clear()
  }

  /** What was written to a running command's terminal (`write_stdin`). Codex
   * names the command it went to, so it is shown there: with the command's
   * input, where it stays once the command ends. A terminal with a tty echoes
   * it into the output as well (probed on 0.170). */
  private terminalInteraction(params: v2.TerminalInteractionNotification): void {
    const command = this.commands.get(params.itemId)
    if (!command || !this.open.has(params.itemId)) return
    command.processId ??= params.processId || null
    if (!params.stdin) return
    command.stdin.push(params.stdin)
    this.emit({
      event: 'tool_call_update',
      data: { toolCallId: params.itemId, rawInput: { ...command.input, stdin: [...command.stdin] } },
    })
  }

  /** The model's plan, re-sent whole on every change: the todo checklist,
   * and a row where the model updated it (Codex has no item for the call). */
  private planUpdated(params: v2.TurnPlanUpdatedNotification): void {
    const entries = params.plan.map(
      (step): PlanEntry => ({
        content: step.step,
        // Codex plans have no priorities; `medium` is the contract's neutral one.
        priority: 'medium',
        status: step.status === 'inProgress' ? 'in_progress' : step.status === 'completed' ? 'completed' : 'pending',
      }),
    )
    this.emit({
      event: 'plan_update',
      data: { entries, ...(params.explanation ? { explanation: params.explanation } : {}) },
    })
    const toolCallId = `plan-${params.turnId}-${++this.plans}`
    this.emit({
      event: 'tool_call',
      data: {
        toolCallId,
        title: CODEX_TOOL_NAMES.plan,
        toolName: CODEX_TOOL_NAMES.plan,
        kind: 'think',
        status: 'completed',
        rawInput: {
          plan: params.plan.map((step) => ({ step: step.step, status: step.status })),
          ...(params.explanation ? { explanation: params.explanation } : {}),
        },
      },
    })
  }

  private hookStarted(run: v2.HookRunSummary): void {
    // A repeat of a start whose run is still open is the same firing.
    if (this.hookRows.has(run.id)) return
    const toolCallId = `hook-${run.id}-${++this.hooks}`
    this.hookRows.set(run.id, toolCallId)
    this.open.add(toolCallId)
    this.emit({ event: 'tool_call', data: { ...hookCall(run, toolCallId), status: 'in_progress' } })
  }

  private hookCompleted(run: v2.HookRunSummary): void {
    const toolCallId = this.hookRows.get(run.id) ?? `hook-${run.id}-${++this.hooks}`
    this.hookRows.delete(run.id)
    const opened = this.open.delete(toolCallId)
    this.settled.add(toolCallId)
    const text = hookText(run)
    const data: ToolCall = {
      ...hookCall(run, toolCallId),
      ...(run.status === 'failed' ? { status: 'failed' as const } : { status: 'completed' as const }),
      ...(text ? { content: [textContent(text)] } : {}),
    }
    this.emit(opened ? { event: 'tool_call_update', data } : { event: 'tool_call', data })
  }

  /** Text a hook put into the conversation, as the model reads it. It arrives
   * whole, as one item. */
  private hookPrompt(item: ItemOf<'hookPrompt'>): void {
    if (this.settled.has(item.id)) return
    this.settled.add(item.id)
    const text = item.fragments.map((fragment) => fragment.text).join('\n\n')
    this.emit({
      event: 'tool_call',
      data: {
        toolCallId: item.id,
        title: CODEX_TOOL_NAMES.hookPrompt,
        toolName: CODEX_TOOL_NAMES.hookPrompt,
        kind: 'other',
        status: 'completed',
        rawInput: { hookRunIds: [...new Set(item.fragments.map((fragment) => fragment.hookRunId))] },
        ...(text ? { content: [textContent(text)] } : {}),
      },
    })
  }

  /** A generation's image, kept, or why there is none. Codex's statuses are
   * the Responses API's (`in_progress`, `completed`, ..., _probed_): only
   * `completed` made an image. */
  private generationResult(
    item: ItemOf<'imageGeneration'>,
  ): Pick<ToolCall, 'status' | 'content'> {
    if (item.failure || item.status !== 'completed')
      return { status: 'failed', content: [textContent(generationFailure(item))] }
    const kept = this.images.get(item.id) ?? generatedImage(item)
    if ('error' in kept)
      return { status: 'failed', content: [textContent(`The generated image could not be kept: ${kept.error}`)] }
    return { status: 'completed', content: [{ type: 'content', content: kept.image }] }
  }

  /** What an item says about its call before it has a result. */
  private callOf(item: Item): ToolCall | undefined {
    switch (item.type) {
      case 'commandExecution':
        return commandCall(item)
      case 'fileChange':
        return {
          toolCallId: item.id,
          title: CODEX_TOOL_NAMES.fileChange,
          toolName: CODEX_TOOL_NAMES.fileChange,
          ...fileChangeFields(item.changes),
        }
      case 'mcpToolCall': {
        const toolName = `mcp__${item.server}__${item.tool}`
        return {
          toolCallId: item.id,
          title: toolName,
          toolName,
          kind: 'other',
          rawInput: item.arguments ?? {},
        }
      }
      case 'dynamicToolCall': {
        const toolName = item.namespace ? `${item.namespace}.${item.tool}` : item.tool
        return { toolCallId: item.id, title: toolName, toolName, kind: 'other', rawInput: item.arguments ?? {} }
      }
      case 'webSearch':
        return {
          toolCallId: item.id,
          title: CODEX_TOOL_NAMES.webSearch,
          toolName: CODEX_TOOL_NAMES.webSearch,
          kind: 'fetch',
          rawInput: webSearchInput(item),
        }
      case 'imageView':
        return {
          toolCallId: item.id,
          title: CODEX_TOOL_NAMES.imageView,
          toolName: CODEX_TOOL_NAMES.imageView,
          kind: 'read',
          rawInput: { path: item.path },
          locations: [{ path: item.path }],
        }
      case 'imageGeneration':
        return {
          toolCallId: item.id,
          title: CODEX_TOOL_NAMES.imageGeneration,
          toolName: CODEX_TOOL_NAMES.imageGeneration,
          kind: 'other',
          rawInput: generationInput(item),
        }
      case 'sleep':
        return {
          toolCallId: item.id,
          title: CODEX_TOOL_NAMES.sleep,
          toolName: CODEX_TOOL_NAMES.sleep,
          kind: 'other',
          rawInput: { durationMs: item.durationMs },
        }
      default:
        return undefined
    }
  }

  /** How a completed item ended, and what it left to read. */
  private resultOf(item: Item): Pick<ToolCall, 'status' | 'outcome' | 'content' | 'rawOutput'> {
    switch (item.type) {
      case 'commandExecution': {
        const output = item.aggregatedOutput
        return {
          ...(noMatches(item) ? { status: 'completed' as const } : ended(item.status)),
          // Running text already streamed; the whole output replaces it.
          ...(output ? { content: [textContent(output)] } : {}),
        }
      }
      case 'fileChange':
        return ended(item.status)
      case 'mcpToolCall': {
        if (item.error) return { status: 'failed', content: [textContent(item.error.message)] }
        const content = mcpResultContent(item.result)
        return { ...ended(item.status), ...(content.length > 0 ? { content } : {}) }
      }
      case 'dynamicToolCall': {
        const content = dynamicContent(item.contentItems)
        const failed = item.status === 'failed' || item.success === false
        return { status: failed ? 'failed' : 'completed', ...(content.length > 0 ? { content } : {}) }
      }
      case 'imageGeneration':
        return this.generationResult(item)
      case 'imageView': {
        // The model has seen it; what is left to say is whether the chat can.
        const read = readImageFile(item.path)
        if ('error' in read)
          return { status: 'failed', rawOutput: { error: `The image could not be shown: ${read.error}` } }
        return { status: 'completed', content: [{ type: 'content', content: read.image }] }
      }
      case 'webSearch':
        return {
          status: 'completed',
          ...(item.results && item.results.length > 0
            ? { content: [textContent(JSON.stringify(item.results, null, 2))] }
            : {}),
        }
      default:
        return { status: 'completed' }
    }
  }
}

/** A Codex status, as a contract status and the outcome that explains a call
 * that did not complete. Codex has no status of its own for an interrupted
 * call; the projection reads a failure during an interrupt as cancelled. */
function ended(status: string): Pick<ToolCall, 'status' | 'outcome'> {
  switch (status) {
    case 'completed':
      return { status: 'completed' }
    case 'declined':
      return { status: 'failed', outcome: 'declined' }
    case 'inProgress':
      return { status: 'in_progress' }
    default:
      return { status: 'failed' }
  }
}

/** The last line of a command left running when its turn ended. */
export const BACKGROUND_NOTE = '\n[Still running in the background]\n'

function textContent(text: string): ToolCallContent {
  return { type: 'content', content: { type: 'text', text } }
}

// ---------------------------------------------------------------------------
// Commands

/**
 * A command row. The input is the command as the model wrote it (Codex runs
 * it wrapped in a login shell, `/bin/bash -lc '…'`, which says nothing), its
 * working directory, where it came from (`source`) and Codex's reading of what
 * it does (`commandActions`). The kind follows those actions: a command that
 * only reads files is a read (a row of paths, like any read), one that is a
 * single search or listing is a search, and anything else runs.
 */
function commandCall(item: ItemOf<'commandExecution'>): ToolCall {
  const actions = item.commandActions ?? []
  const reads = actions.filter((action) => action.type === 'read')
  const kind: ToolKind =
    actions.length > 0 && reads.length === actions.length
      ? 'read'
      : actions.length === 1 && (actions[0]!.type === 'search' || actions[0]!.type === 'listFiles')
        ? 'search'
        : 'execute'
  const locations: ToolCallLocation[] = []
  for (const action of reads)
    if (action.path && !locations.some((held) => held.path === action.path)) locations.push({ path: action.path })
  return {
    toolCallId: item.id,
    title: CODEX_TOOL_NAMES.command,
    toolName: CODEX_TOOL_NAMES.command,
    kind,
    rawInput: {
      command: unwrapShell(item.command),
      cwd: item.cwd,
      source: item.source,
      commandActions: actions,
    },
    ...(locations.length > 0 ? { locations } : {}),
  }
}

/** A search that found nothing: `rg` and `grep` exit 1 and print nothing.
 * It did what it was asked, like any search with no hits. */
function noMatches(item: ItemOf<'commandExecution'>): boolean {
  const actions = item.commandActions ?? []
  return (
    item.status === 'failed' &&
    item.exitCode === 1 &&
    !item.aggregatedOutput?.trim() &&
    actions.length > 0 &&
    actions.every((action) => action.type === 'search')
  )
}

const SHELL_WRAPPER = /^(?:\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/

/**
 * The command inside Codex's shell wrapper: `/bin/bash -lc 'cat a.txt'` is
 * `cat a.txt`. Only a wrapper whose argument is one plain word or one
 * single-quoted string (with `'\''` for a quote, as Codex writes it) is
 * unwrapped; anything else is left as Codex sent it.
 */
export function unwrapShell(command: string): string {
  const wrapped = SHELL_WRAPPER.exec(command.trim())
  if (!wrapped) return command
  const argument = wrapped[1]!
  if (/^[^\s'"\\$`;&|<>()]+$/.test(argument)) return argument
  let inner = ''
  let rest = argument
  while (rest) {
    const quoted = /^'([^']*)'/.exec(rest)
    if (quoted) {
      inner += quoted[1]
      rest = rest.slice(quoted[0].length)
    } else if (rest.startsWith("\\'")) {
      inner += "'"
      rest = rest.slice(2)
    } else return command
  }
  return inner
}

// ---------------------------------------------------------------------------
// File changes

/** A patch's files and line counts. Never its diff: chat carries no file
 * contents. */
function fileChangeFields(
  changes: readonly v2.FileUpdateChange[],
): Pick<ToolCall, 'kind' | 'rawInput' | 'locations' | 'lineChanges'> {
  const locations: ToolCallLocation[] = []
  const touch = (path: string) => {
    if (path && !locations.some((held) => held.path === path)) locations.push({ path })
  }
  let added = 0
  let removed = 0
  const files = changes.map((change) => {
    touch(change.path)
    const counts = diffLines(change)
    added += counts.added
    removed += counts.removed
    if (change.kind.type === 'update' && change.kind.move_path) {
      touch(change.kind.move_path)
      return { path: change.path, kind: 'move', movePath: change.kind.move_path }
    }
    return { path: change.path, kind: change.kind.type }
  })
  const kind: ToolKind =
    files.length > 0 && files.every((file) => file.kind === 'delete')
      ? 'delete'
      : files.length > 0 && files.every((file) => file.kind === 'move')
        ? 'move'
        : 'edit'
  const lineChanges: ToolLineChanges = { added, removed }
  return { kind, rawInput: { changes: files }, ...(locations.length > 0 ? { locations } : {}), lineChanges }
}

/**
 * The lines one change adds and removes, read off the diff Codex reported
 * for it, which is never diffed again here. An added file's diff is its
 * contents, every line added; a deleted file's is what it held, every line
 * removed; an update's is unified hunks, counted by their `+` and `-` lines
 * (a `---`/`+++` header before the first hunk is not a line).
 */
export function diffLines(change: v2.FileUpdateChange): ToolLineChanges {
  const lines = change.diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (change.kind.type === 'add') return { added: lines.length, removed: 0 }
  if (change.kind.type === 'delete') return { added: 0, removed: lines.length }
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('@@')) inHunk = true
    else if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) continue
    else if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

// ---------------------------------------------------------------------------
// MCP and dynamic tools

/**
 * An MCP result as the row shows it. The structured content, when the tool
 * gave one, is the result; its text content is the same thing for the model,
 * so it is shown only without one. Images are kept as images: the environment
 * moves them into the reply, under this call's id, like any tool's image.
 */
function mcpResultContent(result: v2.McpToolCallResult | null): ToolCallContent[] {
  if (!result) return []
  const blocks = (result.content ?? []).flatMap((raw): ContentBlock[] => {
    const block = record(raw)
    switch (block.type) {
      case 'text':
        return typeof block.text === 'string' ? [{ type: 'text', text: block.text }] : []
      case 'image':
        return typeof block.data === 'string' && block.data
          ? [{ type: 'image', mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png', data: block.data }]
          : []
      case 'resource': {
        const resource = record(block.resource)
        return typeof resource.text === 'string' ? [{ type: 'text', text: resource.text }] : []
      }
      case 'resource_link':
        return typeof block.uri === 'string' ? [{ type: 'text', text: block.uri }] : []
      default:
        return []
    }
  })
  const images = blocks.filter((block) => block.type === 'image')
  const structured = result.structuredContent
  const texts =
    structured !== null && structured !== undefined
      ? [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }]
      : blocks.filter((block) => block.type === 'text')
  return [...texts, ...images].map((content) => ({ type: 'content', content }))
}

/** A dynamic tool's output items. An image comes as a URL; only a `data:` URL
 * holds the image itself, and only that one is kept. */
function dynamicContent(items: readonly v2.DynamicToolCallOutputContentItem[] | null): ToolCallContent[] {
  return (items ?? []).flatMap((item): ToolCallContent[] => {
    if (item.type === 'inputText') return item.text ? [textContent(item.text)] : []
    if (item.type === 'inputImage') {
      const image = /^data:([^;,]+);base64,(.+)$/s.exec(item.imageUrl)
      return image ? [{ type: 'content', content: { type: 'image', mimeType: image[1]!, data: image[2]! } }] : []
    }
    return []
  })
}

// ---------------------------------------------------------------------------
// Image generation

/** What a generation was asked, as Codex rewrote the prompt, and where the
 * image came from: the file Codex saved and its generation id. The file is
 * temporary; the chat keeps its own copy. */
function generationInput(item: ItemOf<'imageGeneration'>): Record<string, unknown> {
  return {
    ...(item.revisedPrompt ? { revisedPrompt: item.revisedPrompt } : {}),
    ...(item.savedPath ? { savedPath: item.savedPath } : {}),
    ...(item.generationId ? { generationId: item.generationId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Web search

/** What a web search was asked: a search's query (or queries), a page it
 * opened, or a pattern it looked for in a page. `action` says which. */
function webSearchInput(item: ItemOf<'webSearch'>): Record<string, unknown> {
  const action = item.action
  switch (action?.type) {
    case 'openPage':
      return { action: 'openPage', ...(action.url ? { url: action.url } : {}) }
    case 'findInPage':
      return {
        action: 'findInPage',
        ...(action.url ? { url: action.url } : {}),
        ...(action.pattern ? { pattern: action.pattern } : {}),
      }
    case 'search': {
      const queries = action.queries?.filter(Boolean) ?? []
      const query = item.query || action.query || queries.join(', ')
      return { action: 'search', ...(query ? { query } : {}), ...(queries.length > 1 ? { queries } : {}) }
    }
    default:
      return item.query ? { query: item.query } : {}
  }
}

// ---------------------------------------------------------------------------
// Hooks

function hookCall(run: v2.HookRunSummary, toolCallId: string): ToolCall {
  return {
    toolCallId,
    title: CODEX_TOOL_NAMES.hook,
    toolName: CODEX_TOOL_NAMES.hook,
    kind: 'other',
    rawInput: {
      eventName: run.eventName,
      handlerType: run.handlerType,
      source: run.source,
      sourcePath: run.sourcePath,
    },
  }
}

/** What a hook said: its status line, and each entry under its kind. A hook
 * that blocked the action or stopped the turn did its job, so it completes;
 * its entries say what it decided. */
function hookText(run: v2.HookRunSummary): string {
  const lines: string[] = []
  if (run.status === 'blocked' || run.status === 'stopped') lines.push(run.status === 'blocked' ? 'Blocked' : 'Stopped')
  if (run.statusMessage) lines.push(run.statusMessage)
  for (const entry of run.entries) if (entry.text) lines.push(`${entry.kind}: ${entry.text}`)
  return lines.join('\n')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
