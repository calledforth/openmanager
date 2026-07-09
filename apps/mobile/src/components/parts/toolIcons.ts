import {
  ClipboardList,
  Download,
  FileEdit,
  FilePlus,
  FileSearch,
  FolderSearch,
  Globe,
  ListTodo,
  MessageSquare,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react-native'
import { canonicalizeToolName } from '@openmanager/shared/lib/tool-meta'

// lucide-react-native equivalents of the desktop `ToolRegistry` icon map. Kept
// 1:1 with apps/desktop/.../components/parts/ToolRegistry.ts so the two clients
// present the same glyph per tool.

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

export function getToolIcon(toolName: string): LucideIcon {
  return TOOL_ICONS[canonicalizeToolName(toolName)] ?? Wrench
}
