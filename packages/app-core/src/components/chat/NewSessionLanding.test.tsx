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
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('Select or create a session')
  })

  it('names the environment the new session will run on', () => {
    const html = renderToStaticMarkup(
      <NewSessionLandingView
        environmentLabel="devbox"
        workspaces={[{ path: '/repos/openmanager', name: 'openmanager' }]}
        activeWorkspacePath="/repos/openmanager"
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )

    expect(html).toContain('Sessions run on </span><span class="truncate">devbox</span>')
    expect(html).toContain('Start with a message below')
  })

  it('shows no environment copy when the host does not know one', () => {
    const html = renderToStaticMarkup(
      <NewSessionLandingView
        workspaces={[{ path: '/repos/openmanager', name: 'openmanager' }]}
        activeWorkspacePath="/repos/openmanager"
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )

    expect(html).not.toContain('Sessions run on')
  })

  it('offers recent projects as chips with their capability hints, skipping the active one', () => {
    const html = renderToStaticMarkup(
      <NewSessionLandingView
        workspaces={[
          { path: '/repos/openmanager', name: 'openmanager' },
          { path: '/repos/agentpack', name: 'agentpack' },
          { path: '/repos/notes', name: 'notes' },
          { path: '/repos/gone', name: 'gone', missing: true },
        ]}
        recentWorkspaces={[
          {
            path: '/repos/agentpack',
            name: 'agentpack',
            lastActivityAt: '2026-09-14T10:00:00.000Z',
            capabilities: { git: true, providers: ['cursor', 'codex'] },
          },
          {
            path: '/repos/openmanager',
            name: 'openmanager',
            lastActivityAt: '2026-09-13T10:00:00.000Z',
            capabilities: { git: true, providers: ['cursor'] },
          },
          {
            path: '/repos/gone',
            name: 'gone',
            missing: true,
            lastActivityAt: '2026-09-12T10:00:00.000Z',
            capabilities: { git: false, providers: [] },
          },
        ]}
        activeWorkspacePath="/repos/openmanager"
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="Recent projects"')
    expect(html).toContain('title="/repos/agentpack"')
    expect(html).toContain('git · 2 providers')
    expect(html).toContain('aria-label="git repository"')
    // The active project is the selector, not a chip; missing folders are not offered.
    expect(html).not.toContain('title="/repos/openmanager"')
    expect(html).not.toContain('title="/repos/gone"')
  })

  it('renders no recents row when the host supplies none', () => {
    const html = renderToStaticMarkup(
      <NewSessionLandingView
        workspaces={[{ path: '/repos/openmanager', name: 'openmanager' }]}
        activeWorkspacePath="/repos/openmanager"
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )
    expect(html).not.toContain('Recent projects')
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

  it('says which environment an added folder must live on', () => {
    const html = renderToStaticMarkup(
      <NewSessionLandingView
        environmentLabel="devbox"
        workspaces={[]}
        activeWorkspacePath={null}
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )

    expect(html).toContain('Add a folder on devbox to open a fresh session.')
  })

  it('offers "No project" beside the user\'s projects, never counting it as one', () => {
    const scratch = { path: 'scratch-id', name: 'No project', scratch: true }
    const empty = renderToStaticMarkup(
      <NewSessionLandingView
        workspaces={[scratch]}
        recentWorkspaces={[scratch]}
        activeWorkspacePath={null}
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )
    expect(empty).toContain('Start with a project')
    expect(empty).toContain('or start without a project')

    const inProject = renderToStaticMarkup(
      <NewSessionLandingView
        workspaces={[scratch, { path: '/repos/openmanager', name: 'openmanager' }]}
        recentWorkspaces={[scratch]}
        activeWorkspacePath={null}
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )
    // Opens on the user's project, offers the way out, and no chip for it.
    expect(inProject).toContain('Project: openmanager')
    expect(inProject).toContain('or start without a project')
    expect(inProject).not.toContain('aria-label="Recent projects"')

    const inNoProject = renderToStaticMarkup(
      <NewSessionLandingView
        workspaces={[scratch]}
        activeWorkspacePath="scratch-id"
        isWorkspacesLoading={false}
        isStarting={false}
        onSelectWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
      />,
    )
    expect(inNoProject).toContain('Let&#x27;s build with')
    expect(inNoProject).toContain('Runs in a folder of its own')
    expect(inNoProject).not.toContain('or start without a project')
  })
})
