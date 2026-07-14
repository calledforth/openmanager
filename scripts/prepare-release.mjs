import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const version = process.argv[2]
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

if (!version || !semverPattern.test(version)) {
  console.error('Usage: pnpm release:prepare <semver> (for example, 0.2.0 or 0.2.0-beta.1)')
  process.exit(1)
}

const packageFiles = [resolve('package.json'), resolve('apps/desktop/package.json')]

for (const packageFile of packageFiles) {
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'))
  packageJson.version = version
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`)
}

console.log(`Prepared OpenManager ${version}. Review, commit, merge, and tag the release commit.`)
