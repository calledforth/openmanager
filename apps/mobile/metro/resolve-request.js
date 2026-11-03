// @ts-check
const path = require('path')

/**
 * Packages the bundle must hold exactly once, loaded from the app's own
 * `node_modules` whoever imports them. Under pnpm's isolated linker each
 * workspace package sees its own copy: app-core links a different React patch
 * than the app, and two Reacts in one bundle break every hook.
 */
const DEFAULT_SINGLETONS = ['react', 'react-native']

/** Where a NodeNext `./x.js` may really live in a package that ships TS source. */
const TYPESCRIPT_SUFFIXES = ['.ts', '.tsx']
const TYPESCRIPT_ORIGIN = /\.(c|m)?tsx?$/

function isRelative(moduleName) {
  return moduleName.startsWith('./') || moduleName.startsWith('../')
}

function singletonOf(moduleName, singletons) {
  return singletons.find((name) => moduleName === name || moduleName.startsWith(`${name}/`))
}

/**
 * Metro's `resolver.resolveRequest` for this app, in front of the resolver it
 * is given (Metro's own, or whatever wraps it).
 *
 * 1. Singletons (`react`, `react-native`) are resolved as if the app's root
 *    asked for them.
 * 2. `@openmanager/protocol`, `@agentpack/view` and `@agentpack/contract` ship
 *    TypeScript source written for NodeNext: a relative import names
 *    `./fold/foldProtocolEvent.js` where only `foldProtocolEvent.ts` exists,
 *    because that is the file the compiled build will have. Metro takes the
 *    specifier literally and fails. When a relative `.js` import from a
 *    TypeScript file does not resolve, it is tried again as `.ts`, then
 *    `.tsx`. The packages stay as they are: dropping the suffixes would break
 *    their NodeNext builds (protocol builds the server's `./node` dist).
 *
 * Set `OPENMANAGER_METRO_RESOLVER_LOG=1` to print every rewrite.
 *
 * @param {{
 *   projectRoot: string
 *   singletons?: readonly string[]
 *   log?: (line: string) => void
 * }} options
 */
function createResolveRequest(options) {
  const projectRoot = options.projectRoot
  const singletons = options.singletons ?? DEFAULT_SINGLETONS
  const log = options.log
  const appOrigin = path.join(projectRoot, 'package.json')
  const counts = { singleton: 0, typescript: 0 }

  /**
   * @param {any} context Metro's resolution context
   * @param {string} moduleName
   * @param {string | null} platform
   * @param {(context: any, moduleName: string, platform: string | null) => any} [next]
   */
  function resolveRequest(context, moduleName, platform, next) {
    const resolve = next ?? context.resolveRequest

    const singleton = singletonOf(moduleName, singletons)
    if (singleton && context.originModulePath !== appOrigin) {
      const resolution = resolve({ ...context, originModulePath: appOrigin }, moduleName, platform)
      counts.singleton += 1
      log?.(`[resolver] singleton ${moduleName} <- ${context.originModulePath}`)
      return resolution
    }

    if (
      !isRelative(moduleName) ||
      !moduleName.endsWith('.js') ||
      !TYPESCRIPT_ORIGIN.test(context.originModulePath)
    ) {
      return resolve(context, moduleName, platform)
    }

    try {
      return resolve(context, moduleName, platform)
    } catch (error) {
      const base = moduleName.slice(0, -'.js'.length)
      for (const suffix of TYPESCRIPT_SUFFIXES) {
        try {
          const resolution = resolve(context, base + suffix, platform)
          counts.typescript += 1
          log?.(
            `[resolver] ${moduleName} -> ${base + suffix} (from ${path.relative(projectRoot, context.originModulePath)})`,
          )
          return resolution
        } catch {
          // Try the next suffix; the original error is the one to report.
        }
      }
      throw error
    }
  }

  resolveRequest.counts = counts
  return resolveRequest
}

module.exports = { createResolveRequest, DEFAULT_SINGLETONS }
