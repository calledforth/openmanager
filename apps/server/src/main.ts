import { fileURLToPath } from 'node:url'

/**
 * Entry point. The Node version is checked before anything else loads:
 * the server needs `node:sqlite` and other Node 24 APIs, and an older Node
 * would otherwise fail with an import error that names none of that. The
 * released `openmanager` executable embeds its own Node and always passes.
 */
export const MIN_NODE_MAJOR = 24

const major = Number(process.versions.node.split('.')[0])
if (!(major >= MIN_NODE_MAJOR)) {
  console.error(
    `OpenManager needs Node ${MIN_NODE_MAJOR} or newer; this is Node ${process.versions.node}. ` +
      `Install Node ${MIN_NODE_MAJOR} or newer (nodejs.org, or "nvm install ${MIN_NODE_MAJOR}"), ` +
      'or install the released openmanager executable, which brings its own Node.',
  )
  process.exitCode = 1
} else {
  const { run } = await import('./entry.ts')
  // The service runs this file again; the released executable runs itself.
  await run(fileURLToPath(import.meta.url))
}
