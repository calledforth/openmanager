import {
  ChatIcon,
  DownloadSimpleIcon,
  FileMagnifyingGlassIcon,
  FilePlusIcon,
  FolderOpenIcon,
  GlobeIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PlugsConnectedIcon,
  RobotIcon,
  TerminalIcon,
  TrashIcon,
  WrenchIcon,
  type Icon,
} from 'phosphor-react-native'
import {
  resolveTool,
  type ToolPartData,
  type ToolUiKind,
} from '@openmanager/shared/lib/tool-presenter'

// Phosphor equivalents of web's `ToolRow` icon map (app-core
// components/parts/ToolRow.tsx), kept 1:1 so the two clients show the same
// glyph per tool. The tool is resolved the way web resolves it
// (`resolveTool`): by the provider's name where it gives one (Claude Code,
// OpenCode), else from the title and ACP kind (Cursor), so a call reads the
// same whichever provider ran it.

const TOOL_ICONS: Record<string, Icon> = {
  Bash: TerminalIcon,
  Edit: NotePencilIcon,
  MultiEdit: NotePencilIcon,
  Write: FilePlusIcon,
  Delete: TrashIcon,
  Read: FileMagnifyingGlassIcon,
  Grep: MagnifyingGlassIcon,
  Search: MagnifyingGlassIcon,
  Glob: FolderOpenIcon,
  List: FolderOpenIcon,
  WebSearch: GlobeIcon,
  WebFetch: DownloadSimpleIcon,
  TodoWrite: ListChecksIcon,
  Task: RobotIcon,
  AskUserQuestion: ChatIcon,
}

/** The glyph for a call; `uiKind` is the shared presenter's, which knows an MCP call. */
export function getToolIcon(part: ToolPartData, uiKind?: ToolUiKind): Icon {
  if (uiKind === 'mcp') return PlugsConnectedIcon
  return TOOL_ICONS[resolveTool(part).canonical] ?? WrenchIcon
}
