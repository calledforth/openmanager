/**
 * The web shell is a normal browser app. It must not require Electron IPC
 * or a Convex deployment URL to boot.
 */
export function hasElectronBridge(target: object = globalThis): boolean {
  return 'electronAPI' in target
}
