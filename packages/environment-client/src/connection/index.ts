/**
 * How a client finds, checks and keeps its environments: bootstrap probes,
 * pairing, route fallback and health, the connection state a person reads,
 * and the saved environment registry. Host-neutral by rule (see the
 * `no-restricted-globals` block in the root ESLint config): anything that
 * needs a browser or device API takes it as a parameter.
 */
export * from './bootstrap'
export * from './connection-state'
export * from './environment-store'
export * from './pairing'
export * from './route-fallback'
export * from './route-health'
