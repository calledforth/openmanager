import {
  ClipboardTextIcon,
  DownloadSimpleIcon,
  NotePencilIcon,
  FilePlusIcon,
  FileMagnifyingGlassIcon,
  FoldersIcon,
  GlobeIcon,
  ListChecksIcon,
  ChatIcon,
  MagnifyingGlassIcon,
  TerminalIcon,
  WrenchIcon,
  type Icon,
} from 'phosphor-react-native'
import { canonicalizeToolName } from '@openmanager/shared/lib/tool-meta'

// Phosphor equivalents of the desktop `ToolRegistry` icon map. Kept
// 1:1 with apps/desktop/.../components/parts/ToolRegistry.ts so the two clients
// present the same glyph per tool.

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

export function getToolIcon(toolName: string): Icon {
  return TOOL_ICONS[canonicalizeToolName(toolName)] ?? WrenchIcon
}
