# Changelog

## 0.1.1 — 2026-10-24

- **AGENT_INSTALL.md:** what an AI agent installing (or removing) it for someone checks, asks and writes, and what it
  never does.
- The README has Requirements and a Troubleshooting section with the messages you can see and what to do about them.

## 0.1.0 — 2026-10-24

First release.

- **`/ssh`** points the chat at another machine: a panel with recent connections, saved machines, settings and port
  forwards; `/ssh <machine> [folder]`, `/ssh off`, `/ssh status`. A folder browser picks the project.
- **Login** with a key, the agent, or a password (saved in the macOS Keychain or Secret Service when you choose, or
  turned into key login). One shared connection, which never outlives pi.
- **The model works on the remote:** pi's read, write, edit, bash, grep, find and ls run there, with your login's
  PATH. Esc stops a command and everything it started.
- **sudo** asks for the password on this computer, showing the command; optionally remembered until you disconnect.
- **Extensions keep working on this computer:** files they're given are fetched from the remote, files they save
  for the model are moved there, and the project's `.pi/agent` shows as placeholders.
- **localhost** reaches the remote's ports, except the ports you keep local.
- **The remote's instructions:** the project's AGENTS.md / CLAUDE.md files and its own copy of your global AGENTS.md.
  The git branch in the status line.
- **Reconnects** by itself after a drop; a slow connection and transfers in progress show in the status line.
- **Chats remember their machine:** resume, fork and `/tree` can switch back (ask me, automatically, or not).
- **The model can switch machines** (off by default): `ssh_machines`, `ssh_connect`, `ssh_disconnect`.
- `@` file completion from the remote project, and a debug log (`PI_SEAMLESS_SSH_DEBUG=1`).
- **Remove everything** before uninstalling (also `/ssh remove`): settings, saved machines and passwords, session
  folders, sockets, RAM copies and its copies in npm's cache; afterwards it writes nothing more in that pi.
