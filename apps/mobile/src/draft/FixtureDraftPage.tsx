import { router } from 'expo-router'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useWindowDimensions, type TextInput } from 'react-native'
import type { WorkspaceEntry } from '@openmanager/app-core/logic'

import { ComposerPage } from '../composer/ComposerPage'
import { ComposerSurface } from '../composer/ComposerSurface'
import { useFixtureComposerModel } from '../composer/FixtureComposer'
import type { ProjectSource } from '../composer/ProjectSheet'
import { createComposerUi, fixtureComposerUi, useComposerUiState } from '../composer/ui-state'
import { draftHref } from '../environment/landing-route'
import { FIXTURE_ENVIRONMENTS } from '../home/fixture'
import { SessionThread } from '../session/SessionThread'
import { PhoneDevice } from '../storage/PhoneDevice'
import { EnvironmentSheet, type EnvironmentChoice } from './EnvironmentSheet'
import { NewSessionHead } from './NewSessionLanding'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/**
 * Each sample environment's own projects: the same name on both is two
 * projects, and the page only ever offers the one of the environment it is on.
 */
const PROJECTS: Record<string, { workspaces: WorkspaceEntry[]; recents: string[] }> = {
  'env-desktop': {
    workspaces: [
      { path: 'C:/Users/rajku/.openmanager/scratch', name: 'No project', scratch: true },
      {
        path: 'C:/Users/rajku/OneDrive/Documents/ClePro/openmanager',
        name: 'openmanager',
        lastActivityAt: minutesAgo(2),
        git: { branch: 'dev', worktree: false },
      },
      {
        path: 'C:/Users/rajku/code/t3code',
        name: 't3code',
        lastActivityAt: minutesAgo(90),
      },
      {
        path: 'C:/Users/rajku/code/portfolio',
        name: 'portfolio',
        lastActivityAt: minutesAgo(60 * 26),
      },
      {
        path: 'C:/Users/rajku/.t3/worktrees/openmanager/mobile-pickers',
        name: 'mobile-pickers',
        git: { branch: 'feat/mobile-new-chat-pickers', worktree: true },
      },
      {
        path: 'D:/old/cletus-site',
        name: 'cletus-site',
        missing: true,
        availability: 'missing',
      },
    ],
    recents: ['openmanager', 't3code', 'portfolio'],
  },
  'env-wsl': {
    workspaces: [
      { path: '/home/cletus/.openmanager/scratch', name: 'No project', scratch: true },
      { path: '/home/cletus/agentpack', name: 'agentpack', lastActivityAt: minutesAgo(15) },
      { path: '/home/cletus/openmanager', name: 'openmanager', lastActivityAt: minutesAgo(400) },
      { path: '/home/cletus/dotfiles', name: 'dotfiles' },
    ],
    recents: ['agentpack', 'openmanager'],
  },
}

/** The project each sample environment's page opens in: the one last picked there. */
const LAST_PICKED = new Map<string, string>([
  ['env-desktop', 'C:/Users/rajku/OneDrive/Documents/ClePro/openmanager'],
  ['env-wsl', '/home/cletus/agentpack'],
])

/** Text carried along a sample move, for the page that opens next. */
let carried: { text: string } | null = null

/**
 * A new session's page on the sample home (no environment paired): the
 * live page's views over sample data, so the project, environment and model
 * pickers can be seen and tried. Picking another environment opens its page
 * with what was written, in the project last picked there, as a live move
 * does; nothing reaches a server. `opened` opens a sheet from the address
 * (`?composer=project|environment|model|settings|mode`), for review shots.
 */
export function FixtureDraftPage({
  environmentId,
  opened,
}: {
  environmentId: string
  opened?: string
}) {
  const window = useWindowDimensions()
  const known = PROJECTS[environmentId] ? environmentId : 'env-desktop'
  const lists = PROJECTS[known]!
  const label =
    FIXTURE_ENVIRONMENTS.find((item) => item.environmentId === known)?.label ?? 'This environment'
  const [ui] = useState(() => createComposerUi(fixtureComposerUi(opened, window)))
  const { overlay } = useComposerUiState(ui)
  const [start] = useState(() => {
    const value = carried
    carried = null
    return value
  })
  const model = useFixtureComposerModel({
    draft: true,
    providerId: known === 'env-wsl' ? 'codex' : 'claude',
    initialText: start?.text ?? '',
  })
  const [current, setCurrent] = useState(LAST_PICKED.get(known) ?? null)
  const workspace = lists.workspaces.find((entry) => entry.path === current)
  const recents = useMemo(
    () =>
      lists.recents.flatMap(
        (name) => lists.workspaces.find((entry) => entry.name === name && !entry.scratch) ?? [],
      ),
    [lists],
  )
  const pick = useCallback(
    (path: string) => {
      LAST_PICKED.set(known, path)
      setCurrent(path)
    },
    [known],
  )
  const openEnvironment = useCallback(() => ui.open({ kind: 'environment' }), [ui])
  const projects = useMemo<ProjectSource>(
    () => ({
      environmentLabel: label,
      recents,
      workspaces: lists.workspaces,
      current,
      pick,
      pickEnvironment: openEnvironment,
    }),
    [current, label, lists.workspaces, openEnvironment, pick, recents],
  )
  const choices = useMemo<EnvironmentChoice[]>(
    () =>
      FIXTURE_ENVIRONMENTS.map((item) => ({
        environmentId: item.environmentId,
        label: item.label,
        tone: 'ok',
        reachable: true,
        words: null,
      })),
    [],
  )
  const input = useRef<TextInput>(null)
  const [trayHeight, setTrayHeight] = useState(0)
  const moveTo = (next: string) => {
    ui.close()
    if (model.text.trim()) carried = { text: model.text }
    // In its place, as a live move: the sample home's blank page has an address of its own.
    router.replace(draftHref(next, null) as never)
  }
  return (
    <PhoneDevice>
      <SessionThread
        title="New session"
        status={null}
        messages={[]}
        phase="ready"
        empty={
          <ComposerPage
            model={model}
            ui={ui}
            input={input}
            ready={false}
            onTrayHeight={setTrayHeight}
            head={
              <NewSessionHead
                environmentLabel={label}
                workspace={workspace}
                loading={false}
                note={null}
                recents={recents}
                onPick={() => ui.open({ kind: 'project' })}
                onPickRecent={pick}
                onPickEnvironment={openEnvironment}
              />
            }
          />
        }
        composer={
          <>
            <ComposerSurface
              model={model}
              ui={ui}
              projects={projects}
              page={{ input, trayHeight }}
            />
            {overlay?.kind === 'environment' ? (
              <EnvironmentSheet
                environments={choices}
                current={known}
                carry={model.text.trim() ? 'text' : 'nothing'}
                onPick={moveTo}
                onClose={ui.close}
              />
            ) : null}
          </>
        }
      />
    </PhoneDevice>
  )
}
