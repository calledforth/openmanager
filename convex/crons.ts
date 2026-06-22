import { cronJobs } from 'convex/server'
import { internalMutation } from './_generated/server'
import { internal } from './_generated/api'

// Backstop cleanup for stream_chunks left behind by interrupted streams or
// finalize/delete races. The happy path deletes chunks on finalize; this sweep
// only removes rows older than a window that comfortably exceeds any realistic
// single-message stream, so it never deletes chunks for an actively streaming
// message.
const STALE_CHUNK_MS = 30 * 60 * 1000
const SWEEP_BATCH = 200

export const sweepStaleChunks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_CHUNK_MS
    const stale = await ctx.db
      .query('stream_chunks')
      .withIndex('by_createdAt', (q) => q.lt('createdAt', cutoff))
      .take(SWEEP_BATCH)
    for (const chunk of stale) {
      await ctx.db.delete(chunk._id)
    }
  },
})

const crons = cronJobs()
crons.interval('sweep stale stream chunks', { minutes: 5 }, internal.crons.sweepStaleChunks, {})

export default crons
