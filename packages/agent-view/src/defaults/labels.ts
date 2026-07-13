import type { ToolViewKind } from '../present/toolPresenter.js'

export const defaultToolLabels: Readonly<Record<ToolViewKind, string>> = {
  'file-read': 'Read',
  'file-edit': 'Edited',
  shell: 'Ran command',
  search: 'Searched',
  'web-fetch': 'Fetched',
  subagent: 'Delegated',
  mcp: 'Used integration',
  generic: 'Used tool',
}

export const toolKindLabels = defaultToolLabels
