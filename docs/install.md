# Install the environment server

The environment server is the part of OpenManager that runs on the machine
where your agents work. It ships as a single `openmanager` executable with
Node built in, so the machine needs no Node, npm or repository checkout.

Builds exist for Windows x64, and Linux x64 and arm64 (including WSL). macOS
is not supported yet.

## Install

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/calledforth/openmanager/main/scripts/install.ps1 | iex
```

Linux or WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/calledforth/openmanager/main/scripts/install.sh | sh
```

The script downloads the newest release from
[GitHub Releases](https://github.com/calledforth/openmanager/releases),
checks it against the release's `SHA256SUMS`, and puts the `openmanager`
command on your `PATH`. Open a new terminal afterwards so the command is
found. Running the script again installs the newest version and moves an
installed background service to it, like `openmanager update`; the previous
version stays on disk, older ones are removed.

| Setting                   | Default                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `OPENMANAGER_VERSION`     | the newest release; set it (for example `0.2.0`) to pin one   |
| `OPENMANAGER_INSTALL_DIR` | `%LOCALAPPDATA%\OpenManager`, or `~/.local/share/openmanager` |
| `OPENMANAGER_BIN_DIR`     | `<install folder>\bin` on Windows, `~/.local/bin` on Linux    |

## Run it in the background

```sh
openmanager service install
```

This registers the server with the system and starts it:

- **Windows:** a logon task. The server starts every time you sign in, with no
  window, and keeps running when you close the app or browser. See
  [windows-startup.md](./windows-startup.md).
- **Linux and WSL:** a systemd user unit. WSL needs systemd turned on, and the
  distro shuts down when its last terminal closes unless you change one
  setting. See [linux-systemd.md](./linux-systemd.md).

The server listens on `http://127.0.0.1:43120`. If that port is taken,
`install` picks the next free one and says which. On WSL this includes ports
Windows is already using, because Windows could not reach a WSL server on them.
The port is then fixed: later reinstalls keep it, and `--port` sets one
yourself.

`install` takes the same flags as the server and saves them in the service.
To reach the environment from a phone or another computer through a
Cloudflare tunnel, and to allow the hosted web app:

```sh
openmanager service install --tunnel-hostname om.example.com --allowed-origin https://app.example.com
```

The tunnel needs its token saved first; see
[cloudflare-tunnel.md](./cloudflare-tunnel.md). Running `install` again
replaces every saved flag, so repeat the ones you want to keep.

## Day to day

| Task                                   | Command                             |
| -------------------------------------- | ----------------------------------- |
| Is it running? Which port and folder?  | `openmanager service status`        |
| Follow the log                         | `openmanager service logs --follow` |
| Restart it                             | `openmanager service restart`       |
| Stop it until the next sign-in or boot | `openmanager service stop`          |
| Run it in this terminal instead        | `openmanager --port 43125`          |

Connect a browser or the desktop app with the address `status` prints and the
owner credential in `~/.openmanager/owner-credential`.

## Update

```sh
openmanager update
```

`update` downloads the newest release next to the installed one, checks it,
switches the `openmanager` command to it, and moves the background service
over: the old server stops, the new one starts on the same port with the same
data. Running agent turns are interrupted. Your identity, sessions, paired
devices and credentials stay. The previous version stays on disk until the
next update, in case you need to go back (`openmanager update <version>`).

## Uninstall

```sh
openmanager uninstall
```

This removes the background service, the `openmanager` command and every
downloaded version. It deletes only files OpenManager put in its install
folder, never anything else in it. Your data stays in `~/.openmanager` (or the
`--data-dir` you chose); delete that folder yourself to remove it too.

If the service manager cannot be asked whether a service is installed (for
example `systemctl --user` is unreachable), `uninstall` stops without removing
anything, because a service left pointing at a deleted program fails at every
start. `openmanager uninstall --force` removes the program anyway.

## Where things are

| What                                  | Windows                                   | Linux and WSL                                  |
| ------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Program, one folder per version       | `%LOCALAPPDATA%\OpenManager\versions\<v>` | `~/.local/share/openmanager/versions/<v>`      |
| `openmanager` command                 | `%LOCALAPPDATA%\OpenManager\bin`          | `~/.local/bin` (a link to the current version) |
| Identity, sessions, credentials, logs | `%USERPROFILE%\.openmanager`              | `~/.openmanager`                               |

The program and the data are separate on purpose: updating or uninstalling
never touches the data.

## Development next to an installed server

A server from a repository checkout (`pnpm dev:web`) and the installed one are
two separate environments as long as they use different ports and data
folders. Keep the installed server on its port and `~/.openmanager`, and give
the checkout its own, for example in `.env` at the repository root:

```sh
OPENMANAGER_PORT=43121
OPENMANAGER_DATA_DIR=C:/Users/you/.openmanager-dev
```

Do not give both the same tunnel hostname: two connectors on one tunnel token
split its traffic between them.

From a checkout, `node apps/server/dist/main.js` is the same command as
`openmanager` (it needs Node 24 or newer), and `update`/`uninstall` are
replaced by `git pull`, a rebuild and `service update`.
