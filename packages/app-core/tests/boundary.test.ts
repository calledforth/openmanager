import { beforeAll, describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { resolve } from 'node:path'

const eslint = new ESLint({ cwd: resolve(import.meta.dirname, '../../..') })
const filePath = 'packages/app-core/src/boundary-probe.ts'

// Loading the config (its plugins, and the walk of the logic entry's graph)
// takes seconds on a cold start; do it once here, so each case below times
// only its own lint.
beforeAll(async () => {
  await eslint.calculateConfigForFile(filePath)
  await eslint.lintText('', { filePath })
}, 60_000)

describe('shared application import boundary', () => {
  it.each([
    "import { useQuery } from 'convex/react'",
    "export { api } from '@openmanager/convex/_generated/api'",
    "import type { IpcRenderer } from 'electron'",
    "import store from 'electron-store'",
    "import { readFile } from 'node:fs/promises'",
    "import { readFile } from 'fs/promises'",
    "import { useAppUi } from '../../../apps/desktop/src/renderer/src/providers/app-ui-provider'",
    "import { AgentHost } from '@agentpack/runtime'",
    'const result = window.electronAPI.minimizeWindow()',
    "const result = window['electronAPI'].minimizeWindow()",
    'const { electronAPI } = window',
    "const load = () => import('convex/react')",
    "const load = () => require('electron')",
  ])('rejects %s', async (code) => {
    const [result] = await eslint.lintText(code, { filePath })
    expect(result.errorCount).toBeGreaterThan(0)
    expect(result.messages.some((message) => message.ruleId?.startsWith('no-restricted-'))).toBe(
      true,
    )
  })

  it('allows React, browser-safe contracts, and curated highlighting imports', async () => {
    const [result] = await eslint.lintText(
      `
      import { useState } from 'react'
      import type { ProviderId } from '@agentpack/contract'
      import { cn } from './lib/utils'
      const grammar = import('@shikijs/langs/typescript')
      const engine = import('shiki/wasm')
    `,
      { filePath },
    )
    expect(result.errorCount).toBe(0)
  })
})

// A file the DOM-free entry (`src/logic.ts`) reaches, and one it does not.
const logicFilePath = 'packages/app-core/src/lib/relative-time.ts'
const uiFilePath = 'packages/app-core/src/components/chat/ChatView.tsx'

describe('DOM-free logic entry boundary', () => {
  it.each([
    "import { createPortal } from 'react-dom'",
    "import { createRoot } from 'react-dom/client'",
    "import '../styles/globals.css'",
    "import { motion } from 'motion/react'",
    "import { codeToHtml } from 'shiki'",
    "import { getDocument } from 'pdfjs-dist'",
    "import * as Dialog from '@radix-ui/react-dialog'",
    "import { Popover } from '@base-ui/react/popover'",
    "import { XIcon } from '@phosphor-icons/react'",
    "import leftPad from 'left-pad'",
    'const width = window.innerWidth',
    "const saved = localStorage.getItem('key')",
    'const root = document.body',
    'const ua = globalThis.navigator',
    "const store = globalThis['sessionStorage']",
    'requestAnimationFrame(() => {})',
    "const load = () => import('./theme-families')",
  ])('rejects %s', async (code) => {
    const [result] = await eslint.lintText(code, { filePath: logicFilePath })
    expect(result.errorCount).toBeGreaterThan(0)
    expect(result.messages.some((message) => message.ruleId?.startsWith('no-restricted-'))).toBe(
      true,
    )
  })

  it('allows React, the shared packages and its own modules', async () => {
    const [result] = await eslint.lintText(
      `
      import { useMemo } from 'react'
      import type { ProviderId } from '@agentpack/contract'
      import type { EnvironmentState } from '@openmanager/environment-client'
      import { THEME_FAMILIES } from './theme-families'
      export const ids = (id: ProviderId, state: EnvironmentState) => [id, state, useMemo, THEME_FAMILIES]
    `,
      { filePath: logicFilePath },
    )
    expect(
      result.messages.filter((message) => message.ruleId?.startsWith('no-restricted-')),
    ).toEqual([])
  })

  it('leaves the web UI outside the entry free to use the DOM', async () => {
    const [result] = await eslint.lintText(
      `
      import { createPortal } from 'react-dom'
      export const portal = (node: HTMLElement) => createPortal(null, node ?? document.body)
    `,
      { filePath: uiFilePath },
    )
    expect(
      result.messages.filter((message) => message.ruleId?.startsWith('no-restricted-')),
    ).toEqual([])
  })
})
