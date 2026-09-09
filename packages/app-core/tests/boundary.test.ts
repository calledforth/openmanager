import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { resolve } from 'node:path'

const eslint = new ESLint({ cwd: resolve(import.meta.dirname, '../../..') })
const filePath = 'packages/app-core/src/boundary-probe.ts'

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
