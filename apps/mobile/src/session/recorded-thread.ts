import type { ThreadState } from '@openmanager/environment-client'

/**
 * A thread as the phone's client held it after two live Claude Code turns
 * (a Read, then a shell command and a reply) on a side server, recorded by
 * `live/sessions.live.ts` (`LIVE_THREAD_OUT`). Only its session id was
 * changed, to the fixture row it opens under.
 */
export const RECORDED_THREAD: ThreadState = {
  thread: {
    threadId: 'a3b45825-fde2-4192-b26a-bbc1157930af',
    sessionId: 's-tool-payloads',
  },
  turns: [
    {
      turnId: '8d35ed6f-ccc3-4124-ac88-508d5d95854f',
      threadId: 'a3b45825-fde2-4192-b26a-bbc1157930af',
      state: 'completed',
      startedAt: '2026-10-22T01:24:00.929Z',
      finishedAt: '2026-10-22T01:24:07.801Z',
    },
    {
      turnId: '871df866-35d9-4bd0-b27e-74b52cb8a9c2',
      threadId: 'a3b45825-fde2-4192-b26a-bbc1157930af',
      state: 'completed',
      startedAt: '2026-10-22T01:24:07.901Z',
      finishedAt: '2026-10-22T01:24:15.656Z',
    },
  ],
  messages: [
    {
      messageId: 'b04f9786-9646-4991-ba5a-4f739ba9e5f5',
      threadId: 'a3b45825-fde2-4192-b26a-bbc1157930af',
      turnId: '8d35ed6f-ccc3-4124-ac88-508d5d95854f',
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Read notes.md in this folder, then answer in two short markdown bullet points: what the file is, and its first line.',
        },
      ],
    },
    {
      messageId: 'b820ec9f-86b5-4383-9542-8afc3783f86d',
      threadId: 'a3b45825-fde2-4192-b26a-bbc1157930af',
      turnId: '8d35ed6f-ccc3-4124-ac88-508d5d95854f',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '- **What it is:** A short placeholder file for the phone check. Its only job is to give a live provider turn something to read.\n- **First line:** `# Notes for the phone check`',
        },
      ],
    },
    {
      messageId: 'dd8a539d-3659-44ac-8849-e987f7a59ff6',
      threadId: 'a3b45825-fde2-4192-b26a-bbc1157930af',
      turnId: '871df866-35d9-4bd0-b27e-74b52cb8a9c2',
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'List the files in this folder with a shell command, then write a short paragraph (about 80 words) on why a phone might show a coding session read-only before it can reply. End with a one-line markdown quote.',
        },
      ],
    },
    {
      messageId: '40de65cf-baa1-40f4-8da4-182e48f1a559',
      threadId: 'a3b45825-fde2-4192-b26a-bbc1157930af',
      turnId: '871df866-35d9-4bd0-b27e-74b52cb8a9c2',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'The folder has one file, `notes.md` (92 bytes).\n\nA phone may show a coding session as read-only for a while before you can reply. The session itself runs on another machine, such as a desktop or a cloud worker, and the phone is only a remote view of it. Before it accepts your input, the phone has to reconnect and catch up on the transcript. It also needs to confirm that no turn is still running, because two writers could collide. Your account may also need re-authorizing on that device. Locking input until all of this is done stops messages from being lost or applied twice.\n\n> Look first, then type.',
        },
      ],
    },
  ],
  reasoning: [
    {
      messageId: 'ca391440-96b0-4dd1-9432-947ddc27e9bd',
      turnId: '871df866-35d9-4bd0-b27e-74b52cb8a9c2',
      phase: 'stop',
      content: [],
    },
  ],
  tools: [
    {
      toolCallId: 'e00be7a9-8f14-4375-8930-2204381000c0',
      turnId: '8d35ed6f-ccc3-4124-ac88-508d5d95854f',
      title: 'Read',
      kind: 'read',
      status: 'completed',
    },
    {
      toolCallId: 'bc600f07-e8f0-4a3e-bcda-201fc91893c6',
      turnId: '871df866-35d9-4bd0-b27e-74b52cb8a9c2',
      title: 'PowerShell',
      kind: 'other',
      status: 'completed',
    },
  ],
  order: [
    {
      kind: 'message',
      id: 'b04f9786-9646-4991-ba5a-4f739ba9e5f5',
      turnId: '8d35ed6f-ccc3-4124-ac88-508d5d95854f',
    },
    {
      kind: 'tool',
      id: 'e00be7a9-8f14-4375-8930-2204381000c0',
      turnId: '8d35ed6f-ccc3-4124-ac88-508d5d95854f',
    },
    {
      kind: 'message',
      id: 'b820ec9f-86b5-4383-9542-8afc3783f86d',
      turnId: '8d35ed6f-ccc3-4124-ac88-508d5d95854f',
    },
    {
      kind: 'message',
      id: 'dd8a539d-3659-44ac-8849-e987f7a59ff6',
      turnId: '871df866-35d9-4bd0-b27e-74b52cb8a9c2',
    },
    {
      kind: 'tool',
      id: 'bc600f07-e8f0-4a3e-bcda-201fc91893c6',
      turnId: '871df866-35d9-4bd0-b27e-74b52cb8a9c2',
    },
    {
      kind: 'reasoning',
      id: 'ca391440-96b0-4dd1-9432-947ddc27e9bd',
      turnId: '871df866-35d9-4bd0-b27e-74b52cb8a9c2',
    },
    {
      kind: 'message',
      id: '40de65cf-baa1-40f4-8da4-182e48f1a559',
      turnId: '871df866-35d9-4bd0-b27e-74b52cb8a9c2',
    },
  ],
  interactions: [],
  failures: [],
  notices: [],
  outbox: [],
  hydration: 'ready',
  historyCursor: null,
}
