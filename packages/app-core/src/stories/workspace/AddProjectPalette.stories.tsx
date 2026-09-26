import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo, useState } from 'react'
import { createMockEnvironmentClient } from '@openmanager/environment-client'
import { ThemeProvider } from '../../providers/theme-provider'
import { AddProjectPalette } from '../../components/workspace/AddProjectPalette'

const FOLDERS = {
  'C:\\': ['Program Files', 'Users', 'Windows'],
  'C:\\Users': ['Public', 'you'],
  'C:\\Users\\you': [
    '.cache',
    '.config',
    'AppData',
    'Desktop',
    'Documents',
    'Downloads',
    'OneDrive',
    'code',
  ],
  'C:\\Users\\you\\code': [
    'openmanager',
    'openmanager-cal-200-folder-browser',
    'openmanager-web',
    'tend',
    't3code',
    'dotfiles',
    'playground',
  ],
  'C:\\Users\\you\\code\\openmanager': ['apps', 'docs', 'packages', '.git'],
  'C:\\Users\\you\\Documents': [],
}

function AddProjectDemo({ startsIn = '' }: { startsIn?: string }) {
  const client = useMemo(
    () =>
      createMockEnvironmentClient({
        seed: {
          folders: FOLDERS,
          home: 'C:\\Users\\you',
          environmentSettings: { addProjectStartsIn: startsIn },
        },
      }),
    [startsIn],
  )
  const [open, setOpen] = useState(true)
  return (
    <ThemeProvider>
      <div className="flex h-svh items-start justify-center bg-background p-8 text-foreground">
        <button
          type="button"
          className="rounded-md bg-hover px-3 py-1.5 text-[13px]"
          onClick={() => setOpen(true)}
        >
          Add project
        </button>
      </div>
      <AddProjectPalette
        open={open}
        onOpenChange={setOpen}
        browse={(path, prefix) => client.commands.browseFolders(path, prefix)}
        onAdd={async (path) => {
          await client.commands.addWorkspace({ path })
        }}
      />
    </ThemeProvider>
  )
}

const meta = {
  title: 'App/AddProjectPalette',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const StartsInHome: Story = { render: () => <AddProjectDemo /> }

export const StartsInCode: Story = {
  render: () => <AddProjectDemo startsIn="C:\Users\you\code" />,
}
