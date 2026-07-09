import { vars } from 'nativewind'

export const basisDark = {
  canvasBg: '#141414',
  surface: '#1c1c1c',
  surfaceElevated: '#212121',
  surfaceHover: '#2a2a2a',
  tabActiveBg: '#242424',
  border: '#363636',
  borderMuted: '#2e2e2e',
  text: '#d0d0d0',
  textStrong: '#e0e0e0',
  textMuted: '#8f8f8f',
  textFaint: '#6b6b6b',
  actionBg: '#e5e5e5',
  actionFg: '#111111',
  actionHover: '#f4f4f4',
  destructive: '#cf3030',
  destructiveFg: '#f2f2f2',
} as const

export const basisLight = {
  canvasBg: '#f8f8f8',
  surface: '#fcfcfc',
  surfaceElevated: '#f3f3f3',
  surfaceHover: '#f3f3f3',
  tabActiveBg: '#e7e7e7',
  border: '#dedede',
  borderMuted: '#e7e7e7',
  text: '#2d2d2d',
  textStrong: '#000000',
  textMuted: '#5f5f5f',
  textFaint: '#747474',
  actionBg: '#2a2a2a',
  actionFg: '#f3f3f3',
  actionHover: '#1f1f1f',
  destructive: '#cf3030',
  destructiveFg: '#f2f2f2',
} as const

export type BasisTokenName = keyof typeof basisDark
export type BasisTokens = Record<BasisTokenName, string>

const toVars = (tokens: BasisTokens) =>
  vars({
    '--canvas-bg': tokens.canvasBg,
    '--surface': tokens.surface,
    '--surface-elevated': tokens.surfaceElevated,
    '--surface-hover': tokens.surfaceHover,
    '--tab-active-bg': tokens.tabActiveBg,
    '--border': tokens.border,
    '--border-muted': tokens.borderMuted,
    '--text': tokens.text,
    '--text-strong': tokens.textStrong,
    '--text-muted': tokens.textMuted,
    '--text-faint': tokens.textFaint,
    '--action-bg': tokens.actionBg,
    '--action-fg': tokens.actionFg,
    '--action-hover': tokens.actionHover,
    '--destructive': tokens.destructive,
    '--destructive-fg': tokens.destructiveFg,
    '--background': tokens.canvasBg,
    '--foreground': tokens.text,
    '--card': tokens.surface,
    '--popover': tokens.surfaceElevated,
    '--primary': tokens.textStrong,
    '--muted-foreground': tokens.textMuted,
    '--accent': tokens.surfaceHover,
    '--input': tokens.surface,
  })

export const darkVars = toVars(basisDark)
export const lightVars = toVars(basisLight)
