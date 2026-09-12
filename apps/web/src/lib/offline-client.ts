import {
  EnvironmentClientError,
  createEnvironmentStore,
  type EnvironmentClient,
  type EnvironmentCommands,
} from '@openmanager/environment-client'

const reject = (command: string) => () =>
  Promise.reject<never>(EnvironmentClientError.unsupported(command))

const commands: EnvironmentCommands = {
  getEnvironment: reject('getEnvironment'),
  listWorkspaces: reject('listWorkspaces'),
  addWorkspace: reject('addWorkspace'),
  removeWorkspace: reject('removeWorkspace'),
  listSessions: reject('listSessions'),
  createSession: reject('createSession'),
  openSession: reject('openSession'),
  renameSession: reject('renameSession'),
  deleteSession: reject('deleteSession'),
  sendTurn: reject('sendTurn'),
  interruptTurn: reject('interruptTurn'),
  respondToInteraction: reject('respondToInteraction'),
}

/**
 * The client the shell holds while no environment is ready: empty state,
 * no capabilities, every command rejected. It keeps the application
 * providers mounted across connect and disconnect, so route content (a
 * half-typed settings form, scroll position) survives the transition instead
 * of remounting under a different provider tree.
 */
export function createOfflineEnvironmentClient(): EnvironmentClient {
  const store = createEnvironmentStore()
  const noop = () => undefined
  return {
    commands,
    getState: store.getState,
    subscribe: store.subscribe,
    supports: () => false,
    setActiveSession: noop,
    setActiveThread: noop,
    connect: noop,
    disconnect: noop,
    dispose: noop,
  }
}
