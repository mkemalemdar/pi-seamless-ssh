# How it works

The design, for working on the extension. Words used here:

| Word | Meaning |
|---|---|
| home | the computer pi runs on |
| remote | the machine the chat is pointed at |
| project | the folder on the remote the chat works in |
| routed tools | pi's `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`: they run on the remote |
| home tools | every other tool (extensions, MCP): they run on home |

## Principles

1. **The model lives on the remote.** It sees the remote's paths, OS, `localhost` and instructions. Its tool calls
   are the ordinary ones.
2. **Extensions don't change.** No rule names an extension or a tool. Folders are discovered, files are checked for
   existence, paths are decided by facts.
3. **Settings, logins and chats stay home.**
4. **Nothing is installed on the remote**: SSH and a POSIX shell are enough.
5. **Every bug becomes a test.**

## Source

```
src/index.ts         wiring
src/controller.ts    connecting, disconnecting, the status line, passwords, reopening chats
src/core/            pure logic, unit-tested: targets, paths, listings, sweep plans, settings, the remote's
                     instructions, the login PATH, name rules, the folder browser's rows
src/ssh/             the connection, login prompts (askpass), the remote's commands, file transfers, keychains,
                     key setup
src/routed/          the routed tools: bash (with sudo), read/write/edit/ls/find operations, grep
src/sync/            the session: placeholders, sweeps, moving files, reconnecting, undoing home's changes
src/hooks/           pi events: tool calls and results, input, turns, the system prompt, the context
src/ui/              the /ssh panel, the folder browser, the password box, `@` completion
src/sudo.ts          the sudo password memory
src/model-tools.ts   ssh_machines, ssh_connect, ssh_disconnect
src/log.ts           the debug log
```

## The connection

The system's own `ssh` keeps one **master connection** (`-M -N -S <socket>`, `ControlPersist=no`,
`ServerAliveInterval=10`). Every command, copy and port forward runs over it (`-S <socket>`), so you log in once.

- **It never outlives pi.** The master runs under a small `/bin/sh` watcher that holds a pipe from pi on fd 3. When
  pi exits, even with `kill -9`, the pipe closes and the watcher ends ssh.
- **Logins** go through `SSH_ASKPASS`: a helper script asks pi over a unix socket, and pi shows its password box
  (or answers with a saved password). Host-key questions become a yes/no dialog.
- **Esc while connecting** closes the watcher's pipe: the whole attempt stops, not just one password prompt.
- **A drop** is noticed by ssh's keepalive. The session then tries again by itself (key, agent or saved password) a
  few times, then asks you. Until it's back, routed tools and `!commands` refuse to run.

### Running a script on the remote

ssh is always given the same fixed command, whatever the remote's login shell is:

```sh
/bin/sh -c 'read n; s=$(dd bs=1 count=$n 2>/dev/null); eval "$s"'
```

The script follows on stdin, prefixed with its length, and any data after it. So no script text is in a process's
argument list (`pkill -f` can't hit it), and data after the script is untouched. `sh -s` isn't safe for this: dash
reads ahead and swallows the data.

### The login PATH

Commands over SSH skip your login setup, so folders it adds to PATH are missing. Once per connection (and after a
reconnect), `$SHELL -l -i -c 'printenv PATH'` runs with input from `/dev/null` and a 10 s limit. `-i` matters:
Ubuntu's `.bashrc` stops early otherwise. Markers around the output make anything the startup prints harmless. The
result, merged with the plain PATH (each folder once), is kept on the connection, and every script starts with
`PATH=…; export PATH`.

## Routed tools

pi's own tool definitions are used with operations that run on the remote (`createReadToolDefinition(cwd,
{ operations })` and so on), so their behaviour and output stay pi's. `grep` is replaced: pi's runs ripgrep on home;
here it's the remote's ripgrep, or its grep.

### bash

Each call gets a temporary folder on the remote (`mktemp -d`):

- The command is written to a file and run from it, its output going to a file there. A loop sends what's new every
  0.1 s. So a background program (`npm run dev &`) doesn't hang the call, and keeps running after it.
- Esc or a timeout lists the command's whole process tree with `ps` (the same on Linux and macOS), sends TERM, and
  KILL after 1 s.
- **sudo:** when the remote has sudo, the folder also holds a `sudo` stand-in, first in PATH for the command, which
  runs the real sudo with `-A` and a password helper. The helper makes its own pipe (FIFO), opens it both ways (so
  the answer can arrive before or after it reads), and reports `pid ppid prompt` through another pipe. The call's
  script relays that on stderr; pi shows the password box with the command and writes the answer into the helper's
  pipe. The same sudo (`ppid`) asking again means the answer was wrong. The folder is removed when the call ends.

## The project's `.pi`

- **The remote's `<project>/.pi/agent`** holds this project's pi files: the ones the model made or was given.
- **Home's `.pi` is never moved or hidden.** Every file in the remote's `.pi/agent` gets a **placeholder** at the same
  place under home's agent folder: the real name, size (sparse) and date, no content. pi's own folders (sessions,
  extensions, skills, …) are left out.
- **A name clash:** the remote's file is shown; the home file is set aside (renamed, on the same disk) and put back
  on disconnect.
- **Sweeps** keep both sides in step: after every tool call that may change files, at the start of every turn, and
  when a message arrives. The remote's listing is sent as a delta: it keeps the last one in
  `.pss-list-<session>` and sends only changes (`LC_ALL=C sort` + `comm`). A sweep's plan (create, refresh, remove,
  upload, delete on the remote) is pure logic in `src/core/plan.ts`.
- **Deleting a placeholder** deletes the remote file at the next sweep. A placeholder an extension wrote content
  into is uploaded and becomes a placeholder again.
- **Names:** home's disk may fold case (`A` = `a`) or Unicode forms; this is measured with probe files, and clashes
  are resolved before any placeholder is made.
- **Disconnect** removes the placeholders and puts set-aside files back. Everything a connection changed on home is
  recorded in `current-session.json` first, so a crash is undone at the next start.

## Files between home tools and the remote

| Case | What happens |
|---|---|
| A home tool's input names a remote file | it's copied into a scratch folder for the call (or its placeholder is filled), the tool gets that path, and it's removed after the call |
| A home tool saves to a path the model named | the tool is given a scratch path; after the call the file goes to the named remote path |
| A file an extension saved by itself is mentioned in a message or reply | under pi's agent folder: moved to the same place in the remote's `.pi/agent`, a placeholder stays; elsewhere: to `.pi/agent/from-home/` |
| A path to a placeholder in what the model reads | shown with its remote name (the chat file keeps the original) |

A value counts as a path only when a real file or folder backs it, so plain text is never touched. Scratch copies
live in RAM (`/dev/shm`) on Linux when it's a tmpfs, on disk otherwise.

**Transfers** use `tar` (ustar, `COPYFILE_DISABLE=1` on macOS) over the connection, gzip when the batch is at least
1 MB and compresses well. Files are staged under a `.pss-part` name and renamed when complete, sizes are checked,
and dates are kept. Progress counts the real bytes (before compressing on the way out, after decompressing on the way
in).

## localhost

A home tool's input with `localhost:PORT` / `127.0.0.1:PORT` gets a forward to the remote's port on the shared
connection (`ssh -O forward -L`). If the port is taken on home, a free one is used and the URL changed to match.
Ports kept local are left alone.

## The model's instructions

`before_agent_start` sets pi's system prompt options to the remote: its working folder, and its context files read
by pi's own rules (in each folder the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`,
`CLAUDE.MD`; the agent folder first, then `/` down to the project). The agent folder is the project's own
`<project>/.pi/agent`, which gets a copy of home's global AGENTS.md the first time. One command per run reads them all,
length-prefixed, and the git branch with them (`git symbolic-ref --short -q HEAD`, or the short commit).

## Chats and machines

Each connect and disconnect appends an entry to the chat. On resume, fork and `/tree` the extension looks at the
branch of the point you're on, and connects, disconnects or asks, per the setting.

## Living with pi

- pi's footer git branch can't be set by an extension, so the remote's branch is in the extension's status line.
- Settings are written atomically (a temporary file and a rename), with mode 600.
- The debug log (`PSS_DEBUG=1`) records the first line of each remote command, never the data sent with it.
