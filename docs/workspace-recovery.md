# Recovering unavailable project folders

The environment checks registered folders when listing them and when opening a
session. It stores and publishes `available`, `missing`, or `inaccessible`.
`exists` remains the compatibility flag for whether the folder can be used.
Missing includes paths replaced by a file; inaccessible includes permission
failures, disallowed roots, and roots replaced by a symlink to another location.
Unavailable projects and their sessions stay in the sidebar. Opening a session
shows an error with **Try again**; restoring access lets the same session reopen.

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
restore permissions and the configured allowed roots), then choose **Try again**.
To work at the new path, add it as a project and start a new session there.
Do not remove the original project to recover it: explicit project removal also
deletes its sessions.
