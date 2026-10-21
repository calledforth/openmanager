import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The resolver runs against Metro's own `metro-resolver`, the copy Expo's
 * Metro uses, over the real workspace on disk. Nothing here is a stand-in for
 * Metro's resolution rules; only the file system access is wired by hand.
 */
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '../..')
const requireFromApp = createRequire(path.join(appRoot, 'package.json'))
const requireFromExpo = createRequire(requireFromApp.resolve('expo/package.json'))
const requireFromMetroConfig = createRequire(
  requireFromExpo.resolve('@expo/metro-config/package.json'),
)
const requireFromMetro = createRequire(requireFromMetroConfig.resolve('metro/package.json'))
const metroResolver = requireFromMetro('metro-resolver') as {
  resolve: (context: unknown, moduleName: string, platform: string | null) => Resolution
}
const { createResolveRequest } = requireFromApp('./metro/resolve-request.js') as {
  createResolveRequest: (options: { projectRoot: string; log?: (line: string) => void }) => ((
    context: unknown,
    moduleName: string,
    platform: string | null,
  ) => Resolution) & {
    counts: { singleton: number; typescript: number }
  }
}

type Resolution = { type: 'sourceFile'; filePath: string } | { type: string; filePath?: string }

const packages = new Map<string, Record<string, unknown> | null>()
function readPackage(packageJsonPath: string) {
  if (!packages.has(packageJsonPath)) {
    packages.set(
      packageJsonPath,
      existsSync(packageJsonPath) ? JSON.parse(readFileSync(packageJsonPath, 'utf8')) : null,
    )
  }
  return packages.get(packageJsonPath)!
}

/** The closest package scope of a path, the path itself included, as Metro's file map answers it. */
function packageFor(absolutePath: string) {
  let dir = absolutePath
  for (;;) {
    if (path.basename(dir) === 'node_modules') return null
    const packageJson = readPackage(path.join(dir, 'package.json'))
    if (packageJson) {
      return {
        rootPath: dir,
        packageJson,
        packageRelativePath: path.relative(dir, absolutePath).split(path.sep).join('/'),
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The resolution context Metro builds, over the real file system. */
function contextFor(
  originModulePath: string,
  resolveRequest?: (context: unknown, moduleName: string, platform: string | null) => Resolution,
) {
  const lookup = (candidate: string) => {
    try {
      const stat = statSync(candidate)
      return {
        exists: true as const,
        type: stat.isDirectory() ? 'd' : 'f',
        realPath: realpathSync(candidate),
      }
    } catch {
      return { exists: false as const }
    }
  }
  return {
    allowHaste: false,
    assetExts: new Set(['png', 'jpg', 'ttf']),
    customResolverOptions: {},
    disableHierarchicalLookup: false,
    doesFileExist: (candidate: string) =>
      lookup(candidate).exists && lookup(candidate).type === 'f',
    extraNodeModules: null,
    dev: false,
    fileSystemLookup: lookup,
    getPackage: readPackage,
    getPackageForModule: packageFor,
    mainFields: ['react-native', 'browser', 'main'],
    nodeModulesPaths: [path.join(appRoot, 'node_modules'), path.join(repoRoot, 'node_modules')],
    originModulePath,
    preferNativePlatform: true,
    redirectModulePath: (modulePath: string) => modulePath,
    resolveAsset: () => null,
    resolveHasteModule: () => undefined,
    resolveHastePackage: () => undefined,
    resolveRequest,
    sourceExts: ['ts', 'tsx', 'mjs', 'js', 'jsx', 'json', 'cjs'],
    unstable_conditionNames: ['require', 'import'],
    unstable_conditionsByPlatform: {
      android: ['react-native'],
      ios: ['react-native'],
      web: ['browser'],
    },
    unstable_enablePackageExports: true,
    unstable_logWarning: () => undefined,
  }
}

const defaultResolve = (origin: string, moduleName: string) =>
  metroResolver.resolve(contextFor(origin), moduleName, 'android')

function appResolve(
  origin: string,
  moduleName: string,
  resolver = createResolveRequest({ projectRoot: appRoot }),
) {
  return metroResolver.resolve(contextFor(origin, resolver), moduleName, 'android')
}

const pathOf = (resolution: Resolution) => realpathSync(resolution.filePath!)
const agentView = path.join(repoRoot, 'packages/agent-view/src/index.ts')
const appCoreLogic = path.join(repoRoot, 'packages/app-core/src/logic.ts')

describe('metro resolver', () => {
  it("Metro's own resolver fails on a NodeNext .js import of a .ts file", () => {
    const source = readFileSync(agentView, 'utf8')
    const specifier = /from '(\.\/[^']+\.js)'/.exec(source)![1]!
    expect(existsSync(path.join(path.dirname(agentView), specifier))).toBe(false)
    expect(() => defaultResolve(agentView, specifier)).toThrow()
  })

  it('retries a missing relative .js import from TypeScript as .ts', () => {
    const source = readFileSync(agentView, 'utf8')
    const specifier = /from '(\.\/[^']+\.js)'/.exec(source)![1]!
    const resolution = appResolve(agentView, specifier)
    expect(pathOf(resolution)).toBe(
      realpathSync(path.join(path.dirname(agentView), specifier.replace(/\.js$/, '.ts'))),
    )
  })

  it('leaves a .js import that exists, and one from a JavaScript file, to Metro', () => {
    const calls: string[] = []
    const resolver = createResolveRequest({ projectRoot: appRoot })
    const fake = (_context: unknown, moduleName: string) => {
      calls.push(moduleName)
      throw new Error(`missing ${moduleName}`)
    }
    const context = { originModulePath: path.join(repoRoot, 'x/index.js'), resolveRequest: fake }
    expect(() => resolver(context, './y.js', 'android')).toThrow('missing ./y.js')
    expect(calls).toEqual(['./y.js'])
  })

  it("reports Metro's original error when neither .ts nor .tsx exists", () => {
    const resolver = createResolveRequest({ projectRoot: appRoot })
    const tried: string[] = []
    const context = {
      originModulePath: path.join(repoRoot, 'x/index.ts'),
      resolveRequest: (_context: unknown, moduleName: string) => {
        tried.push(moduleName)
        throw new Error(`missing ${moduleName}`)
      },
    }
    expect(() => resolver(context, './gone.js', 'android')).toThrow('missing ./gone.js')
    expect(tried).toEqual(['./gone.js', './gone.ts', './gone.tsx'])
  })

  it('loads React from the app whoever imports it, so the bundle has one React', () => {
    const fromAppCore = pathOf(defaultResolve(appCoreLogic, 'react'))
    const fromApp = pathOf(defaultResolve(path.join(appRoot, 'index.ts'), 'react'))
    // The isolated linker gives app-core a React of its own.
    expect(fromAppCore).not.toBe(fromApp)
    expect(pathOf(appResolve(appCoreLogic, 'react'))).toBe(fromApp)
    expect(pathOf(appResolve(appCoreLogic, 'react/jsx-runtime'))).toBe(
      pathOf(defaultResolve(path.join(appRoot, 'index.ts'), 'react/jsx-runtime')),
    )
  })

  it('resolves the workspace subpaths the phone imports to their TypeScript source', () => {
    const origin = path.join(appRoot, 'src/environment/controller.ts')
    expect(pathOf(appResolve(origin, '@openmanager/environment-client/connection'))).toBe(
      realpathSync(path.join(repoRoot, 'packages/environment-client/src/connection/index.ts')),
    )
    expect(pathOf(appResolve(origin, '@openmanager/app-core/logic'))).toBe(
      realpathSync(appCoreLogic),
    )
    expect(pathOf(appResolve(origin, '@openmanager/protocol'))).toContain(
      path.join('packages', 'protocol', 'src'),
    )
  })

  it('resolves every import on the shared path the phone loads', () => {
    const resolver = createResolveRequest({ projectRoot: appRoot })
    const entries = [
      path.join(appRoot, 'src/environment/PhoneEnvironmentProvider.tsx'),
      path.join(appRoot, 'src/environment/controller.ts'),
    ]
    const seen = new Set<string>()
    const failures: string[] = []
    const queue = [...entries]
    // Static imports and re-exports; type-only ones are erased by Babel.
    const pattern =
      /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]!
        let resolved: string
        try {
          resolved = pathOf(appResolve(file, specifier, resolver))
        } catch (error) {
          failures.push(
            `${path.relative(repoRoot, file)}: ${specifier} (${(error as Error).message.split('\n')[0]})`,
          )
          continue
        }
        // Walk the workspace's TypeScript; stop at installed packages.
        if (
          /\.(ts|tsx)$/.test(resolved) &&
          !resolved.includes(`${path.sep}node_modules${path.sep}`)
        ) {
          queue.push(resolved)
        }
      }
    }
    expect(failures.join('\n')).toBe('')
    expect(seen.size).toBeGreaterThan(50)
    expect(resolver.counts.typescript).toBeGreaterThan(0)
  })
})
