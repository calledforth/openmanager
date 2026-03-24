import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const SETTINGS_FILE = 'local-settings.json'

interface LocalSettings {
  lastSelectedModelByWorkspace?: Record<string, string>
}

function readSettings(userDataPath: string): LocalSettings {
  const filePath = join(userDataPath, SETTINGS_FILE)
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as LocalSettings
    return parsed ?? {}
  } catch {
    return {}
  }
}

function writeSettings(userDataPath: string, settings: LocalSettings): void {
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(join(userDataPath, SETTINGS_FILE), JSON.stringify(settings, null, 2), 'utf8')
}

export function getLastSelectedModel(userDataPath: string, workspacePath: string): string | null {
  const settings = readSettings(userDataPath)
  const model = settings.lastSelectedModelByWorkspace?.[workspacePath]
  return typeof model === 'string' && model.length > 0 ? model : null
}

export function setLastSelectedModel(
  userDataPath: string,
  workspacePath: string,
  modelId: string,
): void {
  const settings = readSettings(userDataPath)
  const next = {
    ...settings,
    lastSelectedModelByWorkspace: {
      ...(settings.lastSelectedModelByWorkspace ?? {}),
      [workspacePath]: modelId,
    },
  }
  writeSettings(userDataPath, next)
}

