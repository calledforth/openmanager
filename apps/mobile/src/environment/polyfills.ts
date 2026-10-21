/**
 * Runs before anything else in the app (`index.ts` imports it first, ahead of
 * expo-router), so every shared module finds the web platform pieces it
 * calls already in place. See `runtime-fills.ts` for what each one is for.
 *
 * Order matters: the URL fill replaces the global `URL` on import, and the
 * shared connection helpers build URLs as soon as they run.
 */
import 'react-native-url-polyfill/auto'
import { randomUUID } from 'expo-crypto'
import { installAbortSignalTimeout, installRandomUUID, type RuntimeScope } from './runtime-fills'

const scope = globalThis as unknown as RuntimeScope

installAbortSignalTimeout(scope)
installRandomUUID(scope, randomUUID)
