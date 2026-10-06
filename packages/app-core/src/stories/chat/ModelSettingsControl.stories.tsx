import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { SessionConfigOption } from '@agentpack/contract'
import { userEvent, within } from 'storybook/test'
import { ThemeProvider } from '../../providers/theme-provider'
import { ModelSettingsControl, type EffortChoice } from '../../components/chat/ModelSettingsTiles'
import { composerChip, composerFrame } from '../../components/chat/chatComposerStyles'
import { updateSessionConfigOptions } from '../../components/chat/modelConfig'
import { cn } from '../../lib/utils'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

const CLAUDE_EFFORT: EffortChoice[] = [
  { id: 'low', name: 'low', description: 'Minimal thinking, fastest responses' },
  { id: 'medium', name: 'medium', description: 'Moderate thinking' },
  { id: 'high', name: 'high', description: 'Deep reasoning' },
  { id: 'xhigh', name: 'xhigh', description: 'Deeper than high' },
  { id: 'max', name: 'max', description: 'Maximum effort. Session-scoped — never persisted.' },
]

const CONTEXT: SelectOption = {
  type: 'select',
  id: 'context_window',
  name: 'Context window',
  description: 'How much of the conversation Claude keeps before compacting.',
  currentValue: '1m',
  options: [
    { value: '200k', name: '200K', description: '200,000 tokens' },
    { value: '1m', name: '1M', description: '1,000,000 tokens' },
  ],
}

const FAST: SessionConfigOption = {
  type: 'boolean',
  id: 'fast_mode',
  name: 'Fast mode',
  category: 'fast_mode',
  description: 'Trades extra usage for lower latency. Supported on this model.',
  currentValue: false,
}

const STYLE: SelectOption = {
  type: 'select',
  id: 'output_style',
  name: 'Output style',
  category: 'output_style',
  description: "How Claude writes back. Reads the CLI's own installed styles.",
  currentValue: 'default',
  options: [
    { value: 'default', name: 'default' },
    { value: 'Explanatory', name: 'Explanatory' },
    { value: 'Learning', name: 'Learning' },
  ],
}

const MANY_STYLES: SessionConfigOption = {
  ...STYLE,
  options: ['default', 'Explanatory', 'Learning', 'Terse', 'Reviewer', 'Pairing'].map((value) => ({
    value,
    name: value,
  })),
}

/** Holds the options and effort in state so the tiles can be played with. */
function Playground({
  options: initialOptions,
  effort: effortChoices,
  initialEffort = '',
}: {
  options: SessionConfigOption[]
  effort: EffortChoice[]
  initialEffort?: string
}) {
  const [options, setOptions] = useState(initialOptions)
  const [effort, setEffort] = useState(initialEffort)
  return (
    <div className={cn(composerFrame, 'w-full max-w-[44rem] p-1')}>
      <div className="px-2 pb-5 pt-1.5 text-[13px] text-[var(--basis-text-faint)]">
        Ask anything…
      </div>
      <div className="flex items-center gap-0.5">
        <span className={composerChip}>Opus 5.5</span>
        <ModelSettingsControl
          options={options}
          {...(effortChoices.length > 0
            ? { effort: { choices: effortChoices, current: effort, onChange: setEffort } }
            : {})}
          onChange={(id, value) =>
            setOptions((current) => updateSessionConfigOptions(current, id, value) ?? current)
          }
        />
        <span className={composerChip}>Bypass permissions</span>
      </div>
    </div>
  )
}

const meta = {
  title: 'App/ModelSettingsControl',
  component: Playground,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <div className="flex min-h-screen items-end justify-center bg-[var(--basis-canvas-bg)] p-6">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  // Open on load, so the tiles show without a click.
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Model settings' })
    await userEvent.click(trigger)
  },
} satisfies Meta<typeof Playground>

export default meta
type Story = StoryObj<typeof meta>

/** Claude Opus: every setting Claude Code exposes. */
export const Claude: Story = {
  args: { options: [CONTEXT, FAST, STYLE], effort: CLAUDE_EFFORT, initialEffort: 'high' },
}

/** A model whose only setting is effort. */
export const EffortOnly: Story = {
  args: {
    options: [],
    effort: [
      { id: 'minimal', name: 'Minimal', description: 'Barely thinks' },
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium', description: 'Balanced' },
      { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'Extra-high', description: 'Longest thinking' },
    ],
    initialEffort: 'medium',
  },
}

/** No effort control (Haiku), a fixed context window and a long style list,
 *  which opens in place instead of cycling. */
export const NoEffort: Story = {
  args: {
    options: [{ ...CONTEXT, currentValue: '200k', options: [CONTEXT.options[0]!] }, MANY_STYLES],
    effort: [],
  },
}

/** Nothing sent yet: the CLI picks its own depth. */
export const AutoEffort: Story = {
  args: { options: [CONTEXT, { ...FAST, currentValue: true }, STYLE], effort: CLAUDE_EFFORT },
}
