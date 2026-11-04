/**
 * Background work in words, kept apart from the views so the tests read it
 * without React Native.
 */
import type { BackgroundTask } from '@openmanager/environment-client'

export const KIND_LABEL: Record<BackgroundTask['kind'], string> = {
  agent: 'Background agent',
  shell: 'Background command',
  monitor: 'Monitor',
  workflow: 'Workflow',
  other: 'Background task',
}

/** A task's own words, or its kind when it has none. */
export const taskLabel = (task: BackgroundTask) => task.description.trim() || KIND_LABEL[task.kind]

/** "2 background tasks", or the one task's own words. */
export function backgroundSummary(tasks: readonly BackgroundTask[]): string {
  if (tasks.length === 1) return taskLabel(tasks[0]!)
  return `${tasks.length} background tasks`
}
