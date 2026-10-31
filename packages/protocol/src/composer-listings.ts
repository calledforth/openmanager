import { z } from 'zod'
import { EntityIdSchema, TimestampSchema } from './domains.js'
import {
  ComposerCommandOptionSchema,
  ComposerConfigOptionSchema,
  type ComposerListing,
} from './session-composer.js'

const IndexListSchema = z.array(z.number().int().nonnegative())

/**
 * What each provider last listed in each workspace, as the environment
 * snapshot carries it. A new chat has no session to list its settings and
 * commands, so it borrows these.
 *
 * Every entry is nearly the same list: a workspace adds a command or two of
 * its own. So each distinct command and setting is sent once, and an entry
 * names the ones it holds by position. The snapshot goes to every browser on
 * every cold load; whole lists would be most of it.
 */
export const ComposerListingsSnapshotSchema = z
  .object({
    commands: z.array(ComposerCommandOptionSchema),
    configOptions: z.array(ComposerConfigOptionSchema),
    entries: z.array(
      z.object({
        workspaceId: EntityIdSchema,
        providerId: EntityIdSchema,
        commands: IndexListSchema.optional(),
        configOptions: IndexListSchema.optional(),
        updatedAt: TimestampSchema,
      }),
    ),
  })
  .superRefine((listings, ctx) => {
    const within = (indexes: readonly number[] | undefined, length: number) =>
      (indexes ?? []).every((index) => index < length)
    for (const [position, entry] of listings.entries.entries()) {
      if (
        !within(entry.commands, listings.commands.length) ||
        !within(entry.configOptions, listings.configOptions.length)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', position],
          message: 'Listing entry names an item the snapshot does not hold',
        })
      }
    }
  })
export type ComposerListingsSnapshot = z.infer<typeof ComposerListingsSnapshotSchema>

/** One provider's listing in one workspace, whole. */
export interface WorkspaceComposerListing {
  workspaceId: string
  providerId: string
  listing: ComposerListing
  /** When the listing last changed. */
  updatedAt: string
}

/** Shares items by content, so identical ones are sent once. */
function itemTable<T>() {
  const items: T[] = []
  const positions = new Map<string, number>()
  return {
    items,
    positionsOf(list: readonly T[]) {
      return list.map((item) => {
        const key = JSON.stringify(item)
        let position = positions.get(key)
        if (position === undefined) {
          position = items.length
          positions.set(key, position)
          items.push(item)
        }
        return position
      })
    },
  }
}

export function packComposerListings(
  listings: readonly WorkspaceComposerListing[],
): ComposerListingsSnapshot {
  const commands = itemTable<NonNullable<ComposerListing['availableCommands']>[number]>()
  const configOptions = itemTable<NonNullable<ComposerListing['configOptions']>[number]>()
  return {
    entries: listings.map(({ workspaceId, providerId, listing, updatedAt }) => ({
      workspaceId,
      providerId,
      ...(listing.availableCommands
        ? { commands: commands.positionsOf(listing.availableCommands) }
        : {}),
      ...(listing.configOptions
        ? { configOptions: configOptions.positionsOf(listing.configOptions) }
        : {}),
      updatedAt,
    })),
    commands: commands.items,
    configOptions: configOptions.items,
  }
}

export function unpackComposerListings(
  snapshot: ComposerListingsSnapshot,
): WorkspaceComposerListing[] {
  return snapshot.entries.map(
    ({ workspaceId, providerId, commands, configOptions, updatedAt }) => ({
      workspaceId,
      providerId,
      listing: {
        ...(configOptions
          ? { configOptions: configOptions.map((position) => snapshot.configOptions[position]!) }
          : {}),
        ...(commands
          ? { availableCommands: commands.map((position) => snapshot.commands[position]!) }
          : {}),
      },
      updatedAt,
    }),
  )
}
