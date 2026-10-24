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

## Install

```bash
pi install npm:pi-seamless-ssh
```

Needs pi 1.4 or newer, and the OpenSSH client (`ssh`) on this computer.

| | Supported |
|---|---|
| This computer (where pi runs) | macOS, Linux |
| The remote | macOS, Linux, or anything with SSH, a POSIX shell and the usual tools (`tar`, `find`, `awk`, `sed`, …) |
| Windows | no, on either side |

## Use

```
/ssh                      the panel: recent connections, machines, settings
/ssh vm                   connect to a saved machine, then pick the project folder
/ssh me@192.168.1.20      connect to an address (user@host, user@host:port, or a ~/.ssh/config name)
/ssh vm ~/project         connect straight into that folder
/ssh off                  back to this computer
/ssh status               where the chat is working
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
| `~/.pi/agent/pi-seamless-ssh/debug.log` | only with `PSS_DEBUG=1` (see below) |
| `/tmp/pss-<uid>/`, `/dev/shm/pss-<uid>/` | the connection's socket, and short-lived copies (in RAM on Linux) |
| macOS Keychain / Secret Service | saved passwords, only when you tick Save the password |

On the remote: `<project>/.pi/agent/` (the project's pi files and its AGENTS.md copy), a listing file there while
connected, and a temporary folder per command, removed when it ends.

### Remove everything

**[DANGER] › Remove everything…** in the panel deletes everything the extension made on this computer: settings,
saved machines, saved passwords, session folders, sockets, RAM copies and the debug log. Do it before uninstalling;
`pi uninstall` can't run the extension's code. The remotes are left as they are: each project's `.pi/agent`, and
key logins in `~/.ssh/authorized_keys`.

```bash
pi uninstall npm:pi-seamless-ssh
```

## Debug log

```bash
PSS_DEBUG=1 pi
```

writes `~/.pi/agent/pi-seamless-ssh/debug.log`: connections, the first line of each remote command, transfers,
sweeps and problems. Never passwords or file contents.

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

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the design and [docs/TESTING.md](docs/TESTING.md) for the
tests.

```bash
npm run check     # typecheck + unit tests
```

## License

MIT
