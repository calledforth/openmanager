import {
  Terminal,
  FileEdit,
  FilePlus,
  FileSearch,
  Search,
  FolderSearch,
  Globe,
  Download,
  ListTodo,
  ClipboardList,
  MessageSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

interface ToolMeta {
  icon: LucideIcon
  getTitle: (input: unknown) => string
  getSubtitle: (input: unknown) => string
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  multiedit: 'MultiEdit',
  'multi-edit': 'MultiEdit',
  multi_edit: 'MultiEdit',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  websearch: 'WebSearch',
  'web-search': 'WebSearch',
  web_search: 'WebSearch',
  webfetch: 'WebFetch',
  'web-fetch': 'WebFetch',
  web_fetch: 'WebFetch',
  todowrite: 'TodoWrite',
  'todo-write': 'TodoWrite',
  todo_write: 'TodoWrite',
  task: 'Task',
  askquestion: 'AskUserQuestion',
  askuserquestion: 'AskUserQuestion',
  'ask-user-question': 'AskUserQuestion',
  ask_user_question: 'AskUserQuestion',
}

function normalizePath(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  return String(obj.path ?? obj.file_path ?? obj.filePath ?? obj.file ?? '').replace(/\\/g, '/')
}

function basename(path: string): string {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function formatFileTitle(verb: string, input: unknown): string {
  const path = normalizePath(input)
  const name = basename(path)
  return name ? `${verb} ${name}` : verb
}

function extractCommand(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  const cmd = (obj.command ?? '') as string
  return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
}

function extractPattern(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  return String(obj.pattern ?? obj.query ?? obj.regex ?? obj.glob ?? '')
}

const registry: Record<string, ToolMeta> = {
  Bash: {
    icon: Terminal,
    getTitle: () => 'Ran command',
    getSubtitle: (input) => extractCommand(input),
  },
  Edit: {
    icon: FileEdit,
    getTitle: (input) => formatFileTitle('Edited', input),
    getSubtitle: () => '',
  },
  Write: {
    icon: FilePlus,
    getTitle: (input) => formatFileTitle('Created', input),
    getSubtitle: () => '',
  },
  MultiEdit: {
    icon: FileEdit,
    getTitle: (input) => formatFileTitle('Edited', input),
    getSubtitle: () => '',
  },
  Read: {
    icon: FileSearch,
    getTitle: (input) => formatFileTitle('Read', input),
    getSubtitle: () => '',
  },
  Grep: {
    icon: Search,
    getTitle: () => 'Searched code',
    getSubtitle: (input) => extractPattern(input),
  },
  Glob: {
    icon: FolderSearch,
    getTitle: () => 'Listed files',
    getSubtitle: (input) => extractPattern(input),
  },
  WebSearch: {
    icon: Globe,
    getTitle: () => 'Web search',
    getSubtitle: (input) => {
      if (!input || typeof input !== 'object') return ''
      return String((input as Record<string, unknown>).query ?? '')
    },
  },
  WebFetch: {
    icon: Download,
    getTitle: () => 'Fetched URL',
    getSubtitle: (input) => {
      if (!input || typeof input !== 'object') return ''
      const url = String((input as Record<string, unknown>).url ?? '')
      return url.length > 50 ? url.slice(0, 47) + '...' : url
    },
  },
  TodoWrite: {
    icon: ListTodo,
    getTitle: () => 'Updated tasks',
    getSubtitle: () => '',
  },
  Task: {
    icon: ClipboardList,
    getTitle: () => 'Running subagent',
    getSubtitle: (input) => {
      if (!input || typeof input !== 'object') return ''
      return String((input as Record<string, unknown>).description ?? '')
    },
  },
  AskUserQuestion: {
    icon: MessageSquare,
    getTitle: () => 'Asked a question',
    getSubtitle: () => '',
  },
}

const EXPLORING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'])

export function canonicalizeToolName(toolName: string): string {
  if (!toolName) return ''
  return TOOL_NAME_ALIASES[toolName] ?? TOOL_NAME_ALIASES[toolName.toLowerCase()] ?? toolName
}

export function getToolMeta(toolName: string): ToolMeta {
  const canonicalName = canonicalizeToolName(toolName)
  return (
    registry[canonicalName] ?? {
      icon: Wrench,
      getTitle: () => canonicalName || toolName,
      getSubtitle: () => '',
    }
  )
}

export function isExploringTool(toolName: string): boolean {
  return EXPLORING_TOOLS.has(canonicalizeToolName(toolName))
}

export function isCardTool(toolName: string): boolean {
  const canonicalName = canonicalizeToolName(toolName)
  return (
    canonicalName === 'Bash' ||
    canonicalName === 'Edit' ||
    canonicalName === 'Write' ||
    canonicalName === 'MultiEdit'
  )
}
