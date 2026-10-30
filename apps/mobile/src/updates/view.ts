import type { UpdateState } from './updater'

/** The update row's words, and what a tap on it does. */
export type UpdateRowView = {
  title: string
  sub: string
  action: 'check' | 'update' | null
  /** 0–100 while a download of known size runs. */
  percent?: number
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`

export function updateRowView(state: UpdateState, version: string): UpdateRowView {
  switch (state.kind) {
    case 'idle':
    case 'checking':
      return { title: 'Checking for updates', sub: `On version ${version}`, action: null }
    case 'current':
      return { title: 'Up to date', sub: `On version ${version}`, action: 'check' }
    case 'check_failed':
      return { title: 'Could not check for updates', sub: 'Tap to try again', action: 'check' }
    case 'available':
      return {
        title: `Update to ${state.release.version}`,
        sub: `On version ${version} · ${megabytes(state.release.size)} download`,
        action: 'update',
      }
    case 'downloading':
      return state.percent === null
        ? { title: `Downloading ${state.release.version}`, sub: 'Starting', action: null }
        : {
            title: `Downloading ${state.release.version}`,
            sub: `${state.percent}%`,
            action: null,
            percent: state.percent,
          }
    case 'ready':
      return {
        title: `Install ${state.release.version}`,
        sub: 'Downloaded. Android asks you to confirm',
        action: 'update',
      }
    case 'download_failed':
      return {
        title: `Could not download ${state.release.version}`,
        sub: 'Tap to try again',
        action: 'update',
      }
  }
}

/**
 * Whether the home offers the update: a release this phone could take, unless
 * it was put away. A download under way stays until it is done.
 */
export function showsHomeNotice(state: UpdateState, dismissedBuild: number | null): boolean {
  switch (state.kind) {
    case 'available':
    case 'download_failed':
      return state.release.build !== dismissedBuild
    case 'downloading':
    case 'ready':
      return true
    default:
      return false
  }
}
