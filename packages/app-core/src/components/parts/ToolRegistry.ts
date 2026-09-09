import {
  TerminalIcon,
  NotePencilIcon,
  FilePlusIcon,
  FileMagnifyingGlassIcon,
  MagnifyingGlassIcon,
  FoldersIcon,
  GlobeIcon,
  DownloadSimpleIcon,
  ListChecksIcon,
  ClipboardTextIcon,
  ChatIcon,
  WrenchIcon,
  type Icon,
} from '@phosphor-icons/react'
import {
  canonicalizeToolName,
  getToolLabels,
  isCardTool,
  isExploringTool,
} from '@openmanager/shared/lib/tool-meta'

export { canonicalizeToolName, isCardTool, isExploringTool }

interface ToolMeta {
  icon: Icon
  getTitle: (input: unknown) => string
  getSubtitle: (input: unknown) => string
}

const TOOL_ICONS: Record<string, Icon> = {
  Bash: TerminalIcon,
  Edit: NotePencilIcon,
  Write: FilePlusIcon,
  MultiEdit: NotePencilIcon,
  Read: FileMagnifyingGlassIcon,
  Grep: MagnifyingGlassIcon,
  Glob: FoldersIcon,
  WebSearch: GlobeIcon,
  WebFetch: DownloadSimpleIcon,
  TodoWrite: ListChecksIcon,
  Task: ClipboardTextIcon,
  AskUserQuestion: ChatIcon,
}

export function getToolMeta(toolName: string): ToolMeta {
  const canonicalName = canonicalizeToolName(toolName)
  const labels = getToolLabels(toolName)
  return {
    icon: TOOL_ICONS[canonicalName] ?? WrenchIcon,
    getTitle: labels.getTitle,
    getSubtitle: labels.getSubtitle,
  }
}
