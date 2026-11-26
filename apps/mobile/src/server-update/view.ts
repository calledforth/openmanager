import type { ServerUpdateNotice, ServerUpdateWatchSnapshot } from '@openmanager/environment-client'

/**
 * An environment's server version as the phone words it: the row on its
 * page, and the card on the home. A tap updates, tries again, or checks.
 */
export type ServerUpdateRowView = {
  title: string
  sub: string
  action: 'update' | 'check' | null
  tone: 'ok' | 'working' | 'warn' | 'error' | 'idle'
}

const firstLine = (text: string) => text.split('\n').find((line) => line.trim() !== '') ?? text

export function serverUpdateRowView(
  notice: ServerUpdateNotice,
  snapshot: ServerUpdateWatchSnapshot,
): ServerUpdateRowView | null {
  const version = snapshot.status?.currentVersion
  if (snapshot.unsupported) {
    return {
      title: 'Server too old to update from here',
      sub: 'Run “openmanager update” on its machine',
      action: null,
      tone: 'warn',
    }
  }
  switch (notice.kind) {
    case 'available':
      return notice.canUpdate
        ? {
            title: `Update server to ${notice.to}`,
            sub: `On ${notice.from} · it restarts by itself`,
            action: 'update',
            tone: 'ok',
          }
        : {
            title: `Server ${notice.to} is out`,
            sub: notice.reason ?? 'Run “openmanager update” on its machine',
            action: null,
            tone: 'warn',
          }
    case 'updating':
      return {
        title: `Updating server${notice.to ? ` to ${notice.to}` : ''}`,
        sub: 'It stops and starts again; the phone reconnects',
        action: null,
        tone: 'working',
      }
    case 'updated':
      return {
        title: `Server updated to ${notice.to}`,
        sub: `From ${notice.from}`,
        action: 'check',
        tone: 'ok',
      }
    case 'restart_required':
      return {
        title: `${notice.to ?? 'The update'} is installed`,
        sub: 'Restart the server on its machine to finish',
        action: null,
        tone: 'warn',
      }
    case 'failed':
      return {
        title: 'Server update failed',
        sub: `${firstLine(notice.error)} · Tap to try again`,
        action: 'update',
        tone: 'error',
      }
    case 'none':
      if (!version) return null
      return {
        title: `Server ${version}`,
        sub: snapshot.error
          ? firstLine(snapshot.error)
          : snapshot.status?.updatedFrom
            ? `Updated from ${snapshot.status.updatedFrom} · Tap to check again`
            : snapshot.status?.latestVersion
              ? 'Up to date · Tap to check again'
              : 'Tap to check for an update',
        action: 'check',
        tone: snapshot.error ? 'warn' : 'idle',
      }
  }
}

/**
 * Whether the home shows a card for it: news a person would act on or wants
 * to see finish. An offer put away stays away for that version.
 */
export function showsServerUpdateCard(
  notice: ServerUpdateNotice,
  dismissedVersion: string | undefined,
): boolean {
  if (notice.kind === 'available') return notice.to !== dismissedVersion
  return notice.kind !== 'none'
}
