const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const path = require('path')
const { createResolveRequest } = require('./metro/resolve-request')

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [repoRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(repoRoot, 'node_modules'),
]
config.resolver.unstable_enablePackageExports = true

// The workspace packages ship TypeScript source with NodeNext `./x.js`
// imports, and pnpm gives each package its own React. See
// metro/resolve-request.js. Set before NativeWind, which wraps it.
const logResolver = process.env.OPENMANAGER_METRO_RESOLVER_LOG === '1'
const resolveRequest = createResolveRequest({
  projectRoot,
  log: logResolver ? (line) => console.log(line) : undefined,
})
config.resolver.resolveRequest = (context, moduleName, platform) =>
  resolveRequest(context, moduleName, platform)
if (logResolver) {
  process.on('exit', () => {
    console.log(
      `[resolver] rewrote ${resolveRequest.counts.typescript} NodeNext .js imports to TypeScript; pinned ${resolveRequest.counts.singleton} singleton imports to the app`,
    )
  })
}

module.exports = withNativeWind(config, { input: './global.css' })
