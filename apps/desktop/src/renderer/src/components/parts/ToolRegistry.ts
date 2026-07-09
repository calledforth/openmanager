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
import {
  canonicalizeToolName,
  getToolLabels,
  isCardTool,
  isExploringTool,
} from '@openmanager/shared/lib/tool-meta'

export { canonicalizeToolName, isCardTool, isExploringTool }

interface ToolMeta {
  icon: LucideIcon
  getTitle: (input: unknown) => string
  getSubtitle: (input: unknown) => string
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  Bash: Terminal,
  Edit: FileEdit,
  Write: FilePlus,
  MultiEdit: FileEdit,
  Read: FileSearch,
  Grep: Search,
  Glob: FolderSearch,
  WebSearch: Globe,
  WebFetch: Download,
  TodoWrite: ListTodo,
  Task: ClipboardList,
  AskUserQuestion: MessageSquare,
}

export function getToolMeta(toolName: string): ToolMeta {
  const canonicalName = canonicalizeToolName(toolName)
  const labels = getToolLabels(toolName)
  return {
    icon: TOOL_ICONS[canonicalName] ?? Wrench,
    getTitle: labels.getTitle,
    getSubtitle: labels.getSubtitle,
  }
}
