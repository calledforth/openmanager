import { useEffect, useState } from 'react'

import type { DeviceAdminState, ShownPairingLink } from './device-admin'
import type { DeviceConfirm } from './devices'
import { currentDevice } from './devices'

/** The one sheet the environment page shows at a time. */
export type PageSheet =
  | { kind: 'forget' }
  | { kind: 'device'; clientId: string }
  | { kind: 'confirm'; confirm: DeviceConfirm }
  | { kind: 'pair'; reopen: ShownPairingLink | null }
  | { kind: 'titles' }

/**
 * Whether what a sheet is about is still there to show, by what the
 * environment last reported: a device revoked from elsewhere, this phone's
 * own row gone, the admin list unreadable, the titles setting not read.
 */
export function sheetSubjectPresent(
  sheet: PageSheet,
  admin: DeviceAdminState | null,
  context: { appUrl: string | null; titlesRead: boolean },
): boolean {
  switch (sheet.kind) {
    case 'forget':
      return true
    case 'titles':
      return context.titlesRead
    case 'device':
      return admin?.list?.clients.some((item) => item.clientId === sheet.clientId) ?? false
    case 'confirm': {
      if (!admin?.list) return false
      if (sheet.confirm.kind !== 'revoke') return true
      const { clientId } = sheet.confirm
      // While this phone's own revoke runs, its answer closes the sheet.
      if (admin.busy?.kind === 'revoke' && admin.busy.clientId === clientId) return true
      return admin.list.clients.some((item) => item.clientId === clientId)
    }
    case 'pair':
      return Boolean(admin?.list && currentDevice(admin.list) && context.appUrl)
  }
}

/**
 * The page's sheet, closed as soon as its subject leaves (and only a sheet
 * with something to show counts as open), so the page under it is never
 * left hidden from a screen reader behind a sheet that draws nothing.
 */
export function usePageSheet(
  admin: DeviceAdminState | null,
  context: { appUrl: string | null; titlesRead: boolean },
): [PageSheet | null, (sheet: PageSheet | null) => void] {
  const [sheet, setSheet] = useState<PageSheet | null>(null)
  const present = sheet !== null && sheetSubjectPresent(sheet, admin, context)
  useEffect(() => {
    if (sheet !== null && !present) setSheet(null)
  }, [sheet, present])
  return [present ? sheet : null, setSheet]
}
