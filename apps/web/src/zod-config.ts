import { config } from 'zod'

// Zod compiles object parsers with `new Function` when it can, and finds out
// by trying one. The hosted CSP allows no eval, so that probe is refused and
// reported as a violation; parse without it. The setting is global, so it
// covers the copies of zod the shared packages import too. Some of those
// modules parse while they load, which is why main.tsx imports this first.
config({ jitless: true })
