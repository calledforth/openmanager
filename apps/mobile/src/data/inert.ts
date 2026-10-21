// The Convex data layer is gone from the phone: it now reaches its
// environment through `@openmanager/environment-client` (see
// `src/environment`). The hooks in this folder keep their shapes so the
// existing screens compile and render, but read nothing and send nothing
// until those screens move onto the environment client's shared logic.

export const NOT_CONNECTED_MESSAGE = 'This screen has not moved to the environment connection yet.'

export function notConnected(): Promise<never> {
  return Promise.reject(new Error(NOT_CONNECTED_MESSAGE))
}
