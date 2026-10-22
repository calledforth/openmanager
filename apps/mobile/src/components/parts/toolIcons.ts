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

/** The protocol's tool kinds, for a call the environment names in its own words. */
const KIND_ICONS: Record<string, Icon> = {
  read: FileMagnifyingGlassIcon,
  edit: NotePencilIcon,
  delete: NotePencilIcon,
  move: FoldersIcon,
  search: MagnifyingGlassIcon,
  execute: TerminalIcon,
  fetch: DownloadSimpleIcon,
}

export function getToolIcon(toolName: string, kind?: string): Icon {
  return (
    TOOL_ICONS[canonicalizeToolName(toolName)] ??
    (kind ? KIND_ICONS[kind] : undefined) ??
    WrenchIcon
  )
}
