# Recovering unavailable project folders

The environment checks registered folders when listing them and when opening a
session. It stores and publishes `available`, `missing`, or `inaccessible`.
`exists` remains the compatibility flag for whether the folder can be used.
Missing includes paths replaced by a file; inaccessible includes permission
failures and roots replaced by a symlink to another location. Which folder the
environment was started from does not matter: a registered project stays
available across a restart from anywhere.
Unavailable projects and their sessions stay in the sidebar. The project header
says which it is: **MISSING** for a folder that is gone or moved, **NO ACCESS**
for one this environment cannot read. Opening a session shows an error with
**Try again**; restoring access lets the same session reopen.

## The error and what the UI does with it

`session.create`, `session.open` and `turn.send` answer a registered folder that
cannot be used with the `workspace_unavailable` error code and details
`{ workspaceId, availability }`; only a workspace ID the environment does not
know stays `not_found`. Its retry policy is `after_change`: the change is on
disk, so retrying without one fails the same way.

The session's server-owned lifecycle status (docs/session-status.md) is not
touched — nothing ran, so nothing failed. The sidebar instead derives the row
state from the workspace: a session in an unavailable project keeps its status
and is marked unavailable, and the chat pane shows the recovery panel rather
than a spinner. That panel names the folder, says whether it is missing or
unreadable and the on-disk fix for that cause, and
offers **Try again** and a confirming **Delete session** so a session whose
folder is never coming back can still be cleared.

## Moved folders

A missing path may have been moved or deleted. The environment cannot reliably
tell which: folder names, Git remotes, and copies do not establish identity.
It does not search the machine or silently redirect sessions to another folder.

Registering the original canonical path again preserves its workspace ID and
sessions. Registering a different path creates a separate workspace, even if it
has the same name. Existing sessions remain attached to the original workspace.
Automatic rebinding is deliberately unsupported: provider session data may be
indexed by the original working directory, and rebinding only the workspace
record would not guarantee that a provider can resume the correct transcript.

To recover an existing session, restore the folder at its original path (or
restore its permissions), then choose **Try again**.
To work at the new path, add it as a project and start a new session there.
Do not remove the original project to recover it: explicit project removal also
deletes its sessions.
