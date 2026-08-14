import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewSessionLandingView } from './NewSessionLanding'

describe('NewSessionLandingView', () => {
  it('makes the active project the project selector', () => {
    const html = renderToStaticMarkup(
      <NewSessionLandingView
        workspaces={[
          { path: '/repos/openmanager', name: 'openmanager' },
          { path: '/repos/agentpack', name: 'agentpack' },
        ]}
        activeWorkspacePath="/repos/openmanager"
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )

    expect(html).toContain('Let&#x27;s build in')
    expect(html).toContain('openmanager')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).not.toContain('Select or create a session')
  })

  it('shows an add-project action when the workspace list is empty', () => {
    const html = renderToStaticMarkup(
      <NewSessionLandingView
        workspaces={[]}
        activeWorkspacePath={null}
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )

    expect(html).toContain('Start with a project')
    expect(html).toContain('Add project')
  })
})
