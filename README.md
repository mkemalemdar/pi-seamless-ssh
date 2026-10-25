# pi-seamless-ssh

A [pi](https://pi.dev) extension that points a chat at another machine over SSH. pi keeps running on the computer
you type on; the model works on the other machine as if it lived there, and your other extensions keep working
unchanged.

- **The model works on the remote:** pi's `read`, `write`, `edit`, `bash`, `grep`, `find` and `ls` run there, in
  the project folder you pick, with the remote's paths, its OS and its `localhost`.
- **Your extensions keep working on this computer:** WhatsApp, the browser, web search, MCP servers. A file they're
  given is fetched from the remote for the call; a file they save for the model is moved to the remote.
- **The project keeps its own pi files** in `<project>/.pi/agent` on the remote, including its own copy of your
  AGENTS.md. They show on this computer as empty placeholders while you're connected.
- **Nothing to install on the remote:** it only needs SSH and a shell. No mount, no FUSE, no admin rights.
- **Switch machines in the same chat**, disconnect, reconnect: the chat and its context stay.

> 🤖 **AI agent installing or removing this for someone?** Read [AGENT_INSTALL.md](AGENT_INSTALL.md) first: what to
> check and ask, how to write the settings, how to uninstall without leaving anything behind, and what never to touch.

## Requirements

- pi 1.4 or newer, and the OpenSSH client (`ssh`) on this computer.

| | Supported |
|---|---|
| This computer (where pi runs) | macOS, Linux |
| The remote | macOS, Linux, or anything with SSH, a POSIX shell and the usual tools (`tar`, `find`, `awk`, `sed`, …) |
| Windows | no, on either side |

## Install

```bash
pi install npm:pi-seamless-ssh
```

## Use

```
/ssh                      the panel: recent connections, machines, settings
/ssh vm                   connect to a saved machine, then pick the project folder
/ssh me@192.168.1.20      connect to an address (user@host, user@host:port, or a ~/.ssh/config name)
/ssh vm ~/project         connect straight into that folder
/ssh off                  back to this computer
/ssh status               where the chat is working
/ssh remove               remove everything (before uninstalling)
```

1. Type `/ssh`, pick **Connect to an address…** (or **+ Save a machine** to give it a name).
2. Log in. With an SSH key there's nothing to type. With a password, a hidden box asks for it. Tick **Save the
   password** (macOS Keychain, Linux Secret Service), or **Set up key login**, so it isn't asked again.
3. Pick the project folder in the folder browser. **This folder** picks the one you're in; **+ New folder here**
   makes one.

The status line then shows where the chat works: `ssh vm:~/project (main)`, with the project's git branch. From now
on the model works there.

### The folder browser

| Key | Does |
|---|---|
| ↑ ↓ | move |
| → / ← | show / hide a folder's subfolders |
| Enter | go into the folder |
| Space | pick the highlighted folder |
| Esc, Delete | one folder up; at `/`, back to the panel |
| `.` | show or hide hidden folders |

### The panel

```
── ssh ─────────────────────────────────────────────────────────────────────

    [CONNECTED]
  →   Disconnect from vm                     ~/project

    [PORT FORWARDS]
      localhost:3000 → vm:3000

    [RECENT CONNECTIONS]
      vm                                     ~/project

    [MACHINES]
      vm                                     me@192.168.1.20
      + Save a machine
      Connect to an address…

    [SETTINGS]
      Reopening a chat that was connected    ask me
      Status line                            on
      The model can switch machines          off
      Remember the sudo password             off · every sudo asks
      Ports kept local                       none

    [DANGER]
      Remove everything…
```

A saved machine's page has Connect, its name and address, its saved password, and Delete.

## What happens while connected

Until you connect, nothing: the extension takes over none of pi's tools, and runs no ssh, nothing in the background,
and writes nothing. pi works exactly as without it. (pi can't hand a tool back, so after `/ssh off` the tools stay
taken over, passing straight through to pi's own, until the chat ends: `/new`, `/resume`, `/fork`, `/reload` or
quitting.)

### Commands run on the remote

Every command the model runs, and every `!command` you type, runs on the remote in the project folder.

- **Your login's PATH:** when connecting, your login shell on the remote is asked once for its PATH, so commands find
  what your own terminal there finds (`~/.local/bin`, nvm, cargo, Homebrew…). Without it, SSH commands only find
  the standard folders. Your command's text is never changed.
- **Esc** stops the command and everything it started. Background programs (`npm run dev &`) keep running after
  the call.
- **sudo:** there's no terminal on the remote, so pi asks for the password itself. The box shows the command; Esc
  refuses. By default every sudo asks. With **Remember the sudo password** on, the first one you give is kept in
  memory (never saved) until you disconnect, so the model can use sudo without asking. A script that runs
  `/usr/bin/sudo` by its full path isn't covered.

### Files between your extensions and the remote

Your extensions run on this computer; the model's files are on the remote. The extension moves files between them by
itself:

| What happens | Example |
|---|---|
| A tool on this computer is given a remote file: the file is fetched for that call, then deleted again | the model asks WhatsApp to send `shot.png` from the project |
| A tool on this computer saves a file for the model: it's moved to the remote | the browser saves a screenshot; WhatsApp receives a photo |
| A file in the project's `.pi/agent` shows on this computer as an empty placeholder, with its real name, size and date | an extension's old files of this project, next to its own |
| A placeholder that's deleted on this computer is deleted on the remote | WhatsApp's 7-day cleanup |

Home's own pi files (logins, settings, voice models) are never moved or hidden. On disconnect the placeholders go and
everything is as before. Files are copied with `tar` over the same connection, compressed when it helps; the status
line shows a progress bar while a transfer of 1 MB or more is running.

### localhost means the remote

A tool on this computer that opens `localhost:PORT` reaches the remote's port: it's forwarded for you. So the model
can start a web app on the remote and look at it with the browser. Open forwards are listed in the panel, each with a
close button. Ports listed under **Ports kept local** always stay on this computer.

### The model's instructions

The model gets the remote project's instructions: the AGENTS.md / CLAUDE.md files of the project and the folders
above it, plus the project's own copy of your global AGENTS.md. That copy is made the first time you open a project
(`<project>/.pi/agent/AGENTS.md`). From then on it's the project's: edit it there, and an edit applies to your next
message.

### Connections

- One login per connection: every command, file copy and port forward shares it.
- **A dropped connection** is noticed within about 30 s and reconnected by itself (with a key or a saved password);
  otherwise you're asked. While it's down, the model's tools refuse to run. They never fall back to this computer.
- **A slow connection** (over 300 ms) is shown in the status line.
- If pi stops while connected (even if it crashes), the next start puts this computer back as it was.

### Reopening a chat

A chat remembers where each of its points worked. When you resume or fork a chat, or move in it with `/tree`, and
that point worked on another machine, pi can switch there: **ask me** (the default), **reconnect automatically**, or
**don't reconnect**.

### The model switching machines

Off by default. With **The model can switch machines** on, the model gets three tools: `ssh_machines`,
`ssh_connect` (to a saved machine) and `ssh_disconnect`. So you can say "check the logs on lxc". Only machines
that log in without a prompt (a key, or a saved password) can be used this way.

### `@` file completion

While connected, `@` in the input box suggests files from the remote project.

## Files

On this computer:

| Where | What |
|---|---|
| `~/.pi/agent/pi-seamless-ssh/settings.json` | settings, saved machines, recent connections |
| `~/.pi/agent/pi-seamless-ssh/session/` | a connection's private folder, removed on disconnect |
| `~/.pi/agent/pi-seamless-ssh/current-session.json` | what a connection changed on this computer, so it can always be undone |
| `~/.pi/agent/pi-seamless-ssh/debug.log` | only with `PI_SEAMLESS_SSH_DEBUG=1` (see below) |
| `/tmp/pss-<uid>-<id>/`, `/dev/shm/pss-<uid>-<id>/` | the connection's socket, and short-lived copies (in RAM on Linux); `<id>` is short for this pi's agent folder |
| macOS Keychain / Secret Service | saved passwords, only when you tick Save the password |

On the remote: `<project>/.pi/agent/` (the project's pi files and its AGENTS.md copy), a listing file there while
connected, and a temporary folder per command, removed when it ends.

## Uninstall

Do it in this order, so nothing is left behind.

1. **Clean up from inside pi.** Close every other pi window that uses the extension. Then open `/ssh` →
   **[DANGER] › Remove everything…** (or type `/ssh remove`) and confirm. pi:
   - disconnects, and puts this computer's pi files back as they were,
   - deletes `~/.pi/agent/pi-seamless-ssh/`: settings, saved machines, recent connections, session folders and the
     debug log,
   - removes the passwords saved for your machines from the keychain,
   - deletes its sockets and RAM copies, and its copies in npm's download cache, nothing else there,
   - and writes nothing more until you quit, even if you keep using pi.
2. **Quit pi and remove the code:**
   ```bash
   pi uninstall npm:pi-seamless-ssh
   ```

### What isn't removed, on purpose

- **The remote machines:** each project's `.pi/agent` (its files and its AGENTS.md copy) is the project's, and stays
  there. Key logins set up with **Set up key login** stay in that machine's `~/.ssh/authorized_keys`; remove the line
  by hand if you want.
- **Your SSH key:** if the extension made `~/.ssh/id_ed25519` for key login, it's an ordinary key you may use
  elsewhere, so it stays.
- **`~/.ssh/known_hosts`:** the machines you trusted are ssh's own record, as with plain `ssh`.
- **Your pi sessions:** chats that used `/ssh` hold small `pi-seamless-ssh` entries (which machine each point worked
  on). pi ignores them once the extension is gone; cutting them out would break the sessions.

## Troubleshooting

- **"… refused the login":** a wrong password, or the key isn't allowed there. With a password, tick **Set up key
  login** once, and later connections need none.
- **"… host key has changed":** the machine was reinstalled, or someone is intercepting the connection. Check it,
  then remove the old key with `ssh-keygen -R <host>` and connect again.
- **"… isn't a known machine name" / "didn't answer in time":** check the address, the network, and that the SSH
  server runs there.
- **A program works in your terminal on the remote but not for the model** ("command not found"): the extension uses
  your login's PATH, read once when connecting. If it warns "Couldn't read your login PATH", your shell's startup
  files hang or fail without a terminal; fix that, then connect again.
- **"The connection to … is lost. Nothing was run.":** it reconnects by itself with a key or a saved password;
  otherwise `/ssh` asks. Nothing runs on this computer instead.
- **"the macOS Keychain is locked":** pi runs in an SSH session on the Mac, where the Keychain can't be opened, so
  the password wasn't saved. Set up key login instead.
- **sudo says "a terminal is required":** the command runs sudo by its full path (`/usr/bin/sudo …`), which skips
  the extension's password box. Run it as `sudo …`.
- **More detail:** start pi with `PI_SEAMLESS_SSH_DEBUG=1 pi`. It writes `~/.pi/agent/pi-seamless-ssh/debug.log`:
  connections, the first line of each remote command, transfers, sweeps and problems. Never passwords or file
  contents.

## Limits

- Windows isn't supported, on either side.
- No terminal on the remote: interactive programs (`vim`, `top`, a password prompt other than sudo's) can't be used.
- A tool on this computer that runs a **script given as text** sees no remote paths inside that text (e.g. browser
  code that uploads a remote file).
- An extension that opens an old file **on its own**, without the model naming it in a tool call, reads an empty
  placeholder.
- pi's own footer line keeps showing this computer's folder and branch; the remote's are in the `ssh …` status line.
- Over SSH, the Mac's Keychain is locked: passwords can't be saved when pi itself runs in an SSH session on a Mac.

## Development

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the design, [docs/TESTING.md](docs/TESTING.md) for the
tests, and [AGENT_INSTALL.md](AGENT_INSTALL.md) for what an AI agent installing it does.

```bash
npm run check     # typecheck + unit tests
```

## License

MIT
