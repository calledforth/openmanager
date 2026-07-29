/** The reply to `agent:ensure`: did the provider answer this one round trip?
 *
 * Deliberately still a boolean, and deliberately not a status. The durable,
 * multi-axis answer to "does this CLI work?" is `ProviderHealth` in
 * ./provider-health, pushed separately on `agent:status-changed`.
 *
 * `SidecarStatus` used to live here. It was one enum conflating install, auth
 * and runtime state, it could not tell "never started" from "start failed",
 * and its `'unhealthy'` member was never assigned by any code path. Phase 3
 * replaced it with `ProviderHealth`. */
export interface SidecarHandshake {
  ready: boolean
}
