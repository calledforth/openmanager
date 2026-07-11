import { useEffect, useMemo, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorkspaceSidebarView } from '../components/sidebar/WorkspaceSidebarView'
import { ChatViewPanel, UserMessage, AssistantMessage } from '../components/chat/ChatViewPrimitives'
import { MessageInputView } from '../components/chat/MessageInputView'
import { FloatingChatComposer } from '../components/chat/FloatingChatComposer'
import { ThemeProvider } from '../providers/theme-provider'
import { AppUiProvider } from '../providers/app-ui-provider'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'

const meta = {
  title: 'App/ChatShellPlayground',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>
type Preset = 'normal' | 'error' | 'parallel'

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  isFinal?: boolean
  parts?: StreamMessagePart[]
}

function patch(parts: StreamMessagePart[], id: string, next: Partial<StreamMessagePart>) {
  return parts.map((part) => (part.id === id ? { ...part, ...next } : part))
}

function add(parts: StreamMessagePart[], part: StreamMessagePart): StreamMessagePart[] {
  return [...parts, part]
}

function finalizeToolStates(parts: StreamMessagePart[], preset: Preset): StreamMessagePart[] {
  return parts.map((part) => {
    if (part.type === 'reasoning') {
      const p = part as StreamMessagePart & { time?: { start?: number; end?: number } }
      if (p.time && typeof p.time.end !== 'number') {
        return { ...p, time: { ...p.time, end: Date.now() } }
      }
      return part
    }
    if (part.type !== 'tool') return part
    const current = (part as StreamMessagePart & { state?: Record<string, unknown> }).state ?? {}
    const stateType = String(current.type ?? current.status ?? '')
    if (stateType !== 'pending' && stateType !== 'running' && stateType !== 'input-streaming') {
      return part
    }
    if (preset === 'error') {
      return {
        ...part,
        state: {
          ...current,
          type: 'error',
          status: 'error',
          error: String(current.error ?? 'Simulation ended with tool still running'),
        },
      }
    }
    return {
      ...part,
      state: {
        ...current,
        type: 'completed',
        status: 'completed',
        output: String(current.output ?? 'Simulation finalized this tool state'),
      },
    }
  })
}

function settleInFlightForStep(parts: StreamMessagePart[], preset: Preset): StreamMessagePart[] {
  return parts.map((part) => {
    if (part.type === 'reasoning') {
      const p = part as StreamMessagePart & { time?: { start?: number; end?: number } }
      if (p.time && typeof p.time.end !== 'number') {
        return { ...p, time: { ...p.time, end: Date.now() } }
      }
      return part
    }
    if (preset === 'parallel' || part.type !== 'tool') return part
    const current = (part as StreamMessagePart & { state?: Record<string, unknown> }).state ?? {}
    const stateType = String(current.type ?? current.status ?? '')
    if (stateType !== 'pending' && stateType !== 'running' && stateType !== 'input-streaming') {
      return part
    }
    return {
      ...part,
      state: {
        ...current,
        type: preset === 'error' ? 'error' : 'completed',
        status: preset === 'error' ? 'error' : 'completed',
        ...(preset === 'error'
          ? { error: String(current.error ?? 'Step advanced while tool still running') }
          : { output: String(current.output ?? 'Completed when next step started') }),
      },
    }
  })
}

function patchTool(
  parts: StreamMessagePart[],
  id: string,
  next: Record<string, unknown>,
): StreamMessagePart[] {
  return parts.map((part) => {
    if (part.id !== id) return part
    const tool = part as StreamMessagePart & { state?: Record<string, unknown> }
    return { ...tool, state: { ...(tool.state ?? {}), ...next } }
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REALISTIC MOCK DATA
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function makeDenseHistory(): Msg[] {
  const turns: [string, string][] = [
    [
      'Why does the font look generic even though we use Inter?',
      "The issue is threefold: no font-feature-settings, static weight files from Google Fonts instead of a variable font, and Tailwind defaults for line-height that produce a slightly loose rhythm. I've identified four concrete changes to fix this.",
    ],
    [
      'Can you investigate why tool calls flicker during streaming?',
      'The flicker is caused by component remounting when the parts array reference changes identity on each chunk. The fix is to key components by part ID and apply structural equality before triggering re-renders. No state is lost once the key is stable.',
    ],
    [
      'How is bandwidth usage so high in the streaming path?',
      "Every chunk broadcasts the full message body through Convex's realtime subscription. The fix is a delta-cursor approach: only the new chunk and a cursor index are pushed, and clients reconstruct the body incrementally. This cuts bandwidth by ~90% for long sessions.",
    ],
    [
      'Refactor the sidebar collapse state to persist across restarts.',
      "Done. I used electron-store to persist the collapsed workspace paths. The key is written on toggle and read during startup before the first render, so there's no layout flash.",
    ],
    [
      'Set up Storybook for the renderer so I can prototype UI changes safely.',
      'Storybook is wired up with the Tailwind v4 Vite plugin, a preview that imports globals.css, and three story files covering the chat view, message input, and workspace sidebar. You can now prototype without touching the main application.',
    ],
    [
      'What changes did OpenCode make to Inter that we are missing?',
      "Two things: they self-host a variable font file covering weight 100–900, and they enable ss03 — Inter's geometric stylistic set — globally. Both together change how every character renders.",
    ],
  ]
  return turns.flatMap(([userMsg, assistantMsg], i) => [
    { id: `seed-u-${i}`, role: 'user' as const, content: userMsg },
    { id: `seed-a-${i}`, role: 'assistant' as const, content: assistantMsg, isFinal: true },
  ])
}

// The full assistant reply that streams word-by-word
const ASSISTANT_REPLY = `I've applied four typography changes to the renderer. Here's a summary of what changed and why each matters.

## What Changed

### 1. Self-hosted variable font

Inter is now loaded via \`@fontsource-variable/inter\` instead of the Google Fonts CDN. The variable font file covers the full weight axis \`100–900\` in a single \`.woff2\`, which means the browser interpolates weight continuously rather than snapping to the five discrete stops that Google Fonts served.

\`\`\`css
/* before */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700');

/* after */
@import "@fontsource-variable/inter";
\`\`\`

### 2. Geometric glyphs via ss03

Inter's Stylistic Set 03 swaps the default humanist letterforms for more geometric alternatives — most visibly on \`a\`, \`g\`, \`l\`, and \`t\`. This is the single change that makes Inter look like a design tool rather than a browser default. It is now enabled globally on \`html\`.

\`\`\`css
html {
  font-feature-settings: "ss03" 1;
}
\`\`\`

### 3. Named type scale

Replaced ad-hoc Tailwind \`text-xs\` / \`text-sm\` with a named scale that matches OpenCode's system: 11 / 13 / 14 / 16 / 20 px at weights 400 or 500 only. No \`font-semibold\` (600) anywhere in UI chrome.

| Class | Size | Weight | Line height |
|-------|------|--------|-------------|
| \`.text-13-regular\` | 13px | 400 | 1.5 |
| \`.text-14-regular\` | 14px | 400 | 1.8 |
| \`.text-14-medium\` | 14px | 500 | 1.5 |
| \`.text-20-medium\` | 20px | 500 | 1.8 |

### 4. Line-height tokens

Three named tokens replace \`leading-relaxed\` (1.625) wherever it appeared:

- \`--lh-tight: 1.3\` — compact UI rows, tool call headers
- \`--lh-default: 1.5\` — base body, user messages, sidebar items
- \`--lh-loose: 1.8\` — assistant prose, markdown paragraphs

The net effect is that reading long AI responses feels less vertically padded — more like a native app, less like a webpage.
`

// Splits a string into per-word streaming steps
function wordChunks(
  partId: string,
  fullText: string,
): Array<(parts: StreamMessagePart[]) => StreamMessagePart[]> {
  // Split on spaces but preserve newlines as their own tokens
  const tokens = fullText
    .split(/(\n)/)
    .flatMap((segment) => (segment === '\n' ? ['\n'] : segment.split(' ').filter((w) => w !== '')))
  return tokens.map((token) => (parts: StreamMessagePart[]) => {
    const current =
      (parts.find((p) => p.id === partId) as { text?: string } | undefined)?.text ?? ''
    const isNewline = token === '\n'
    const separator = current === '' || current.endsWith('\n') || isNewline ? '' : ' '
    return patch(parts, partId, { text: current + separator + token })
  })
}

function buildStreamParts(_prompt: string): StreamMessagePart[] {
  const t0 = Date.now()
  return [
    {
      type: 'reasoning',
      id: 'p-reason',
      text: 'The user wants me to look at the font rendering.\n\nLet me start by checking what Inter variant is actually loaded — Google Fonts vs self-hosted — and whether font-feature-settings is set at all on the root element. I also need to check what Tailwind utilities are being used for font-weight across the component tree, since mixing semibold and medium is a common source of visual inconsistency.\n\nPlan:\n1. Grep for font-feature-settings in globals.css\n2. Read the current index.html to check the Google Fonts link\n3. Enumerate all font-semibold usages across tsx files\n4. Install @fontsource-variable/inter\n5. Rewrite globals.css: variable font import, ss03, type scale, LH tokens\n6. Patch index.html: remove CDN link, update CSP\n7. Patch components: font-semibold→medium, leading-relaxed→normalized tokens\n8. typecheck:web',
      time: { start: t0 },
    },
  ]
}

function buildStreamUpdates(
  _prompt: string,
  preset: Preset,
): Array<(parts: StreamMessagePart[]) => StreamMessagePart[]> {
  const normal = [
    // Step 1: grep for font-feature-settings
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-grep-ff',
        tool: 'Grep',
        state: {
          type: 'pending',
          input: {
            pattern: 'font-feature-settings',
            include: '*.css',
            path: 'src/renderer/src/styles',
          },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-grep-ff', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-grep-ff', {
        type: 'completed',
        output: 'No results found.',
      }),
    // Step 2: read globals.css
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-read-css',
        tool: 'Read',
        state: {
          type: 'pending',
          input: { filePath: 'src/renderer/src/styles/globals.css' },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-read-css', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-read-css', {
        type: 'completed',
        output:
          'Read globals.css (181 lines). Found: @import tailwindcss, @theme block, body rule with -webkit-font-smoothing. No font-feature-settings. Font loaded as static weights 300;400;500;600;700 from fonts.googleapis.com.',
      }),
    // Step 3: read index.html
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-read-html',
        tool: 'Read',
        state: {
          type: 'pending',
          input: { filePath: 'src/renderer/index.html' },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-read-html', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-read-html', {
        type: 'completed',
        output:
          'Read index.html (29 lines). Confirmed: Google Fonts link for Inter with discrete weights 300;400;500;600;700. No variable font. Body inline style sets font-family but no font-feature-settings.',
      }),
    // Step 4: grep for font-semibold
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-grep-semi',
        tool: 'Grep',
        state: {
          type: 'pending',
          input: { pattern: 'font-semibold', include: '*.tsx', path: 'src/renderer/src' },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-grep-semi', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-grep-semi', {
        type: 'completed',
        output:
          'Found 6 results:\nsrc/renderer/src/components/permissions/PermissionPrompt.tsx:32\nsrc/renderer/src/components/parts/TextPart.tsx:63,87,90,93\nsrc/renderer/src/components/chat/ChatView.tsx:82',
      }),
    // Step 5: install variable font
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-bash-install',
        tool: 'Bash',
        state: {
          type: 'pending',
          input: {
            command: 'bun add @fontsource-variable/inter',
            description: 'Install self-hosted variable Inter font',
          },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-bash-install', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-bash-install', {
        type: 'completed',
        output:
          '[1.73ms] ".env.local"\nbun add v1.3.10 (30e609e0)\n\ninstalled @fontsource-variable/inter@5.2.8\n\n1 package installed [2.87s]',
      }),
    // Step 6: write globals.css
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-write-css',
        tool: 'Write',
        state: {
          type: 'pending',
          input: {
            filePath: 'src/renderer/src/styles/globals.css',
            description: 'Add variable font import, ss03, type scale utilities, line-height tokens',
          },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-write-css', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-write-css', {
        type: 'completed',
        output:
          'Wrote globals.css (+259 lines, -180 lines).\nAdded: @import @fontsource-variable/inter, font-feature-settings "ss03" 1 on html, body font-size 13px, :root LH tokens (1.3/1.5/1.8), type scale utilities (.text-13-regular through .text-20-medium).',
      }),
    // Step 7: patch index.html
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-edit-html',
        tool: 'Edit',
        state: {
          type: 'pending',
          input: {
            filePath: 'src/renderer/index.html',
            description: 'Remove Google Fonts CDN link, update CSP',
          },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-edit-html', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-edit-html', {
        type: 'completed',
        output:
          'Removed: <link rel="preconnect" fonts.googleapis.com>, Google Fonts stylesheet link.\nUpdated CSP: removed fonts.googleapis.com from style-src, replaced font-src with \'self\' data:.',
      }),
    // Step 8: patch components
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-edit-comp',
        tool: 'MultiEdit',
        state: {
          type: 'pending',
          input: {
            files: [
              'TextPart.tsx',
              'ChatViewPrimitives.tsx',
              'ChatView.tsx',
              'PermissionPrompt.tsx',
            ],
            description: 'font-semibold → font-medium, leading-relaxed → normalized LH tokens',
          },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-edit-comp', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-edit-comp', {
        type: 'completed',
        output:
          'Patched 4 files:\n  TextPart.tsx: h1/h2/h3/th font-semibold→font-medium, leading-relaxed→leading-[1.5], text wrapper leading-[1.8]+text-[14px]\n  ChatViewPrimitives.tsx: user bubble leading-[1.5], assistant body leading-[1.8]\n  ChatView.tsx: workspace name text-2xl font-semibold→text-20-medium\n  PermissionPrompt.tsx: font-semibold→font-medium',
      }),
    // Step 9: typecheck
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-bash-tc',
        tool: 'Bash',
        state: {
          type: 'pending',
          input: {
            command: 'pnpm typecheck:web',
            description: 'Verify no type errors after edits',
          },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-bash-tc', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-bash-tc', {
        type: 'completed',
        output:
          '$ pnpm typecheck:web\n$ tsc --noEmit -p tsconfig.web.json\n\n(no errors)\n\nexit code 0',
      }),
  ]

  const error = [
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-bash',
        tool: 'Bash',
        state: {
          type: 'pending',
          input: { command: 'pnpm typecheck:web', description: 'Verify typings after edits' },
        },
      }),
    (parts: StreamMessagePart[]) => patchTool(parts, 'p-bash', { type: 'running' }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-bash', {
        type: 'error',
        output:
          "$ pnpm typecheck:web\n$ tsc --noEmit -p tsconfig.web.json\nsrc/renderer/src/components/chat/ChatViewPrimitives.tsx:105:13 - error TS2322: Type 'string' is not assignable to type 'never'.\n\nexit code 1",
      }),
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-read-err',
        tool: 'Read',
        state: {
          type: 'running',
          input: {
            filePath: 'src/renderer/src/components/chat/ChatViewPrimitives.tsx',
            startLine: 100,
            endLine: 115,
          },
        },
      }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-read-err', {
        type: 'completed',
        output:
          'Read ChatViewPrimitives.tsx lines 100–115. Found cn() call with mismatched conditional type in className string.',
      }),
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-edit-fix',
        tool: 'Edit',
        state: {
          type: 'running',
          input: {
            filePath: 'src/renderer/src/components/chat/ChatViewPrimitives.tsx',
          },
        },
      }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-edit-fix', {
        type: 'error',
        error: 'Write blocked: file is open in editor. Close the file or approve the override.',
      }),
  ]

  const parallel = [
    (parts: StreamMessagePart[]) =>
      add(
        add(parts, {
          type: 'tool',
          id: 'p-grep-a',
          tool: 'Grep',
          state: { type: 'running', input: { pattern: 'font-semibold', include: '*.tsx' } },
        }),
        {
          type: 'tool',
          id: 'p-grep-b',
          tool: 'Grep',
          state: { type: 'running', input: { pattern: 'leading-relaxed', include: '*.tsx' } },
        },
      ),
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-task',
        tool: 'Task',
        state: {
          type: 'running',
          input: {
            description: 'Audit CSS token usage across all components',
            subagent_type: 'explore',
          },
        },
      }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-grep-b', {
        type: 'completed',
        output: 'leading-relaxed: 16 usages across 5 files.',
      }),
    (parts: StreamMessagePart[]) =>
      add(parts, {
        type: 'tool',
        id: 'p-read-oc',
        tool: 'Read',
        state: {
          type: 'running',
          input: { filePath: 'opencode.ref/packages/ui/src/styles/utilities.css' },
        },
      }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-grep-a', {
        type: 'completed',
        output: 'font-semibold: 6 usages in 4 files.',
      }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-task', {
        type: 'completed',
        output:
          'Subagent audit: 0 usages of font-bold, 6 of font-semibold, 16 of leading-relaxed. All replaceable with 400/500 weight system.',
      }),
    (parts: StreamMessagePart[]) =>
      patchTool(parts, 'p-read-oc', {
        type: 'completed',
        output:
          'Read utilities.css (119 lines). OpenCode type scale confirmed: .text-12-regular through .text-20-medium, weights 400/500 only, no semibold or bold anywhere in UI chrome.',
      }),
  ]

  const scenario = preset === 'error' ? error : preset === 'parallel' ? parallel : normal

  return [
    ...scenario,
    // Close the thinking block with full reasoning summary
    (parts) =>
      patch(parts, 'p-reason', {
        text: 'Confirmed: no font-feature-settings, Google Fonts static weights, 6× font-semibold, 16× leading-relaxed.\n\nFix plan:\n1. Install @fontsource-variable/inter → full-axis variable font, no CDN\n2. Add font-feature-settings: "ss03" 1 to html → geometric glyphs\n3. Rewrite globals.css: LH tokens (1.3/1.5/1.8), type scale (11/13/14/16/20px), body at 13px\n4. Remove CDN link from index.html, tighten CSP to \'self\' only\n5. Patch components: font-semibold→medium, leading-relaxed→lh tokens\n6. typecheck:web — confirmed 0 errors',
        time: { start: Date.now() - 8400, end: Date.now() },
      }),
    // Start empty text part, then stream word-by-word
    (parts) => add(parts, { type: 'text', id: 'p-text', text: '' }),
    ...wordChunks('p-text', ASSISTANT_REPLY),
  ]
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEMO COMPONENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function Demo() {
  const [collapsed, setCollapsed] = useState(false)
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>('connected')
  const [modeId, setModeId] = useState('default')
  const [modelId, setModelId] = useState('claude-sonnet-4-5')
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: 'welcome-a',
      role: 'assistant',
      content:
        'Hey! This is the typography playground. Send a prompt (or use the buttons below) to watch a realistic agent session stream in — tool calls, thinking block, and a word-by-word markdown reply with code blocks.',
      isFinal: true,
    },
  ])
  const [streaming, setStreaming] = useState(false)
  const [sessionStatus, setSessionStatus] = useState<'idle' | 'running' | 'error'>('idle')
  const [preset, setPreset] = useState<Preset>('normal')
  const scrollRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, streaming])

  useEffect(() => {
    return () => {
      if (!timerRef.current) return
      clearInterval(timerRef.current)
    }
  }, [])

  const startStream = (prompt: string, nextPreset: Preset = preset) => {
    if (status !== 'connected') return
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setMessages((prev) =>
      prev.map((msg) =>
        msg.role === 'assistant' && msg.isFinal === false && msg.parts
          ? { ...msg, isFinal: true, parts: finalizeToolStates(msg.parts, preset) }
          : msg,
      ),
    )
    const userId = `u-${Date.now()}`
    const assistantId = `a-${Date.now()}`
    const parts = buildStreamParts(prompt)
    const updates = buildStreamUpdates(prompt, nextPreset)
    let idx = 0

    setSessionStatus('running')
    setStreaming(true)
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', content: prompt, isFinal: true },
      { id: assistantId, role: 'assistant', content: '', isFinal: false, parts },
    ])

    timerRef.current = setInterval(() => {
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== assistantId || !msg.parts) return msg
          const settled = settleInFlightForStep(msg.parts, nextPreset)
          if (idx >= updates.length) {
            return { ...msg, isFinal: true, parts: finalizeToolStates(settled, nextPreset) }
          }
          return { ...msg, parts: updates[idx](settled) }
        }),
      )
      idx += 1
      if (idx <= updates.length) return
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
      setStreaming(false)
      setSessionStatus(nextPreset === 'error' ? 'error' : 'idle')
    }, 80) // 80ms per word/token — realistic feel
  }

  const stopStream = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setStreaming(false)
    setSessionStatus('idle')
    setMessages((prev) =>
      prev.map((msg) =>
        msg.role === 'assistant' && msg.isFinal === false && msg.parts
          ? { ...msg, isFinal: true, parts: finalizeToolStates(msg.parts, preset) }
          : msg,
      ),
    )
  }

  const workspaces = useMemo(
    () => [
      {
        path: '/workspace/openmanager',
        name: 'openmanager',
        sessions: [
          {
            externalId: 'sess-1',
            title: 'Typography system refactor',
            status: sessionStatus,
          },
          { externalId: 'sess-2', title: 'Storybook view setup', status: 'idle' },
          { externalId: 'sess-3', title: 'Convex streaming overhaul', status: 'idle' },
        ],
      },
      {
        path: '/workspace/opencode.ref',
        name: 'opencode.ref',
        sessions: [{ externalId: 'sess-101', title: 'Reference audit', status: 'idle' }],
      },
    ],
    [sessionStatus],
  )

  return (
    <ThemeProvider>
      <AppUiProvider>
        <div className="flex h-screen w-screen min-w-0 overflow-hidden bg-background text-foreground selection:bg-accent/25 selection:text-foreground">
          <WorkspaceSidebarView
            collapsed={collapsed}
            workspaces={workspaces}
            activeWorkspacePath="/workspace/openmanager"
            activeSessionId="sess-1"
            collapsedWorkspacePaths={[]}
            onToggleWorkspaceCollapse={() => undefined}
            onCreateSession={() => undefined}
            onSelectSession={() => undefined}
            onDeleteSession={() => undefined}
            onRemoveWorkspace={() => undefined}
            onAddWorkspace={() => undefined}
          />

          <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden pt-2 pr-2 pb-0 pl-0 transition-all duration-300 ease-in-out">
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-xl border border-border bg-card">
              <ChatViewPanel>
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                  <div className="mx-auto max-w-2xl space-y-1 px-4 py-6 pb-44">
                    {messages.map((msg) =>
                      msg.role === 'user' ? (
                        <UserMessage key={msg.id} content={msg.content} />
                      ) : (
                        <AssistantMessage
                          key={msg.id}
                          isFinal={msg.isFinal}
                          content={msg.content}
                          parts={msg.parts}
                          runtime={{
                            providerId: 'anthropic',
                            modelId,
                            modeId,
                            tokens: { total: 1200 + messages.length * 33 },
                          }}
                        />
                      ),
                    )}
                  </div>
                </div>
              </ChatViewPanel>

              <FloatingChatComposer>
                <div className="pb-2">
                  <div className="mx-auto flex max-w-2xl flex-wrap gap-1.5 text-11-regular text-muted-foreground">
                    <button
                      className="rounded border border-border px-2 py-1 hover:bg-surface-hover transition-default"
                      onClick={() => setStatus('connected')}
                    >
                      connected
                    </button>
                    <button
                      className="rounded border border-border px-2 py-1 hover:bg-surface-hover transition-default"
                      onClick={() => setStatus('connecting')}
                    >
                      connecting
                    </button>
                    <button
                      className="rounded border border-border px-2 py-1 hover:bg-surface-hover transition-default"
                      onClick={() => setStatus('disconnected')}
                    >
                      disconnected
                    </button>
                    <button
                      className="rounded border border-border px-2 py-1 hover:bg-surface-hover transition-default"
                      onClick={() => setMessages((prev) => [...makeDenseHistory(), ...prev])}
                    >
                      seed history (6 turns)
                    </button>
                    <button
                      className="rounded border border-border px-2 py-1 hover:bg-surface-hover transition-default"
                      onClick={() => {
                        setPreset('normal')
                        startStream(
                          'Apply the four font changes we identified: variable font, ss03, type scale, and line-height tokens.',
                          'normal',
                        )
                      }}
                    >
                      ▶ run normal
                    </button>
                    <button
                      className="rounded border border-border px-2 py-1 hover:bg-surface-hover transition-default"
                      onClick={() => {
                        setPreset('error')
                        startStream('Run typecheck and fix any errors.', 'error')
                      }}
                    >
                      ▶ run errors
                    </button>
                    <button
                      className="rounded border border-border px-2 py-1 hover:bg-surface-hover transition-default"
                      onClick={() => {
                        setPreset('parallel')
                        startStream(
                          'Audit font-semibold and leading-relaxed usages in parallel, then report.',
                          'parallel',
                        )
                      }}
                    >
                      ▶ run parallel
                    </button>
                    <button
                      className="rounded border border-border px-2 py-1 hover:bg-surface-hover transition-default"
                      onClick={() => setMessages([])}
                    >
                      clear
                    </button>
                  </div>
                </div>

                <MessageInputView
                  disabled={status !== 'connected'}
                  pendingDraftSessionStart={false}
                  activeWorkspacePath="/workspace/openmanager"
                  activeSessionId="sess-1"
                  isSessionDraftOpen={false}
                  openCodeReady={status === 'connected'}
                  providerOptions={[
                    { id: 'opencode', name: 'OpenCode' },
                    { id: 'cursor', name: 'Cursor' },
                  ]}
                  currentProviderId="opencode"
                  modeOptions={[
                    { id: 'default', name: 'Default' },
                    { id: 'plan', name: 'Plan' },
                    { id: 'debug', name: 'Debug' },
                  ]}
                  currentModeId={modeId}
                  modelOptions={[
                    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
                    { id: 'claude-opus-4', name: 'Claude Opus 4' },
                    { id: 'gpt-5.1', name: 'GPT-5.1' },
                  ]}
                  currentModelId={modelId}
                  canChangeSettings={true}
                  canChangeProvider={false}
                  showModeControl={true}
                  showModelControl={true}
                  agent={{ name: 'OpenCode', version: '1.7.0' }}
                  isStreaming={false}
                  onModeChange={setModeId}
                  onProviderChange={() => {}}
                  onModelChange={setModelId}
                  onSend={(prompt) => startStream(prompt, preset)}
                  onAbort={() => {}}
                />
              </FloatingChatComposer>
            </div>
          </div>
        </div>
      </AppUiProvider>
    </ThemeProvider>
  )
}

export const Playground: Story = {
  render: () => <Demo />,
}
