# Installing (and uninstalling) pi-seamless-ssh: notes for AI agents

This file is for an AI agent (pi, Claude Code, Codex, …) asked to install or remove this extension for a user. Read it
fully before changing anything. **Asked to remove it?** Go to [Uninstalling](#uninstalling).

## What you can and can't do

- **You can:**
  - check this computer and the machines the user wants to reach, and install the package
  - ask the user how they want it set up, and write the settings file for them (saved machines, settings)
- **You can't:**
  - **type a password**: the password box is hidden and only the user types into it. Never ask for a password in the
    chat, and never write one into a file.
  - **decide to trust a machine's host key**: that's the user's decision, on their first connection
  - use the `/ssh` panel: it's an interactive terminal UI meant for the user
- So the install ends with the **user** starting pi and connecting once. Tell them exactly how (see "Hand over").

## 1. Check the machine

Do these yourself before asking anything, so your questions can include the results.

- **The system:** macOS or Linux (`uname -s`). Windows isn't supported, on either side: say so and stop there.
- **pi** 1.4 or newer: `pi --version`.
- **The ssh client:** `ssh -V` (OpenSSH). Without it, nothing works; it's usually installed (`sudo apt install
  openssh-client`; built into macOS).
- **Command conflicts:** this extension registers `/ssh`. List what's registered:
  ```bash
  echo '{"type":"get_commands"}' | pi --mode rpc | grep '"get_commands"'
  ```
  If another package registers `/ssh` (each entry shows its `source`), tell the user it has to go first, and ask
  before removing it.
- **Machines already set up for ssh:** `grep -iE '^host ' ~/.ssh/config` (names here work in `/ssh` as they are),
  and `ls ~/.ssh/*.pub` (a key means key login is possible).
- **Can a password be saved?** macOS: the Keychain (only when pi runs in the Mac's own desktop session, not over
  SSH). Linux: `command -v secret-tool` (Secret Service); otherwise a private file in the extension's folder.
- **Each machine the user names:** `ssh -o BatchMode=yes <user@host> true` (with `-p <port>` for another port)
  tells you whether key login already works (exit 0). Don't try passwords.

## 2. Ask the basics

Ask these together, in one message, and wait for the answers:

1. **Which machines?** For each one: a short name (e.g. `vm`) and the address: `user@host`, `user@host:port`, or a
   name from `~/.ssh/config`. Say which ones already log in with a key (from your check).
2. **Login for those that ask for a password:** set up key login (recommended: on the first connection, tick **Set up
   key login** in the password box, and later connections need nothing), save the password (in the keychain from
   your check), or ask for it every time.
3. **Let the model switch machines by itself?** Off by default. On, the model gets `ssh_machines`, `ssh_connect` and
   `ssh_disconnect`, for "check the logs on lxc". Only machines that log in without a prompt can be used this way.
4. **sudo on the remote:** every sudo asks the user in pi (showing the command) by default. **Remember the sudo
   password** keeps the first one given until disconnecting, which lets the model use sudo without asking. Off unless
   they ask; warn them if they want it.

## 3. Offer the other settings

Then show these in **one** message, with the defaults, and ask which they want changed ("defaults are fine" is a fine
answer; everything can be changed later in `/ssh`):

| Setting (name in `/ssh`) | What it does | Default | Other choices |
|---|---|---|---|
| Reopening a chat that was connected | When a chat is resumed, forked, or moved in with `/tree` and that point worked on another machine | **ask me** | reconnect automatically · don't reconnect |
| Status line | `ssh vm:~/project (main)` at the bottom of pi while connected | **on** | off |
| Ports kept local | Ports that keep pointing at this computer while connected (every other `localhost` port reaches the remote) | **none** | port numbers, e.g. a local database |

## 4. Install

```bash
pi install npm:pi-seamless-ssh
pi list    # should show npm:pi-seamless-ssh
```

## 5. Write the settings

Settings live in `~/.pi/agent/pi-seamless-ssh/settings.json` (`$PI_CODING_AGENT_DIR/pi-seamless-ssh/` if that's set).
Unknown or invalid values become the defaults, so writing only what differs is safe. Make the folder private
(`chmod 700`) and the file too (`chmod 600`). If a pi with this extension is running, ask the user to quit it first.

```json
{
  "reopen": "ask",
  "statusLine": true,
  "modelTools": false,
  "sudoRemember": false,
  "localPorts": [5432],
  "machines": [
    { "name": "vm", "address": "me@192.168.1.20", "keep": "key" },
    { "name": "box", "address": "box" }
  ]
}
```

| Field | Setting | Values |
|---|---|---|
| `reopen` | Reopening a chat that was connected | `ask` (default) · `reconnect` · `home` (don't reconnect) |
| `statusLine` | Status line | boolean, default `true` |
| `modelTools` | The model can switch machines | boolean, default `false` |
| `sudoRemember` | Remember the sudo password | boolean, default `false` |
| `localPorts` | Ports kept local | port numbers |
| `machines` | Saved machines | `name` (unique), `address` (what ssh is given), `keep`: `key` (tick Set up key login on the password box), `password` (tick Save the password), or leave it out (just ask) |

Leave out `recent` and `savedPasswords`: the extension fills them in itself. There is no field for a password.

## 6. Hand over to the user

Tell the user:

1. Start pi: `pi`
2. Type `/ssh vm` (the name of a saved machine), or `/ssh` to see the panel.
3. If it asks for a password, type it into the box; the tick you chose is already set. A new machine asks first
   whether to trust its host key: compare the fingerprint if they can.
4. Pick the project folder in the folder browser (Enter goes in, Space picks, `.` shows hidden folders).

Then tell them, briefly:

- From now on the model works there: its commands and files are the remote's. Their `!commands` run there too.
- Their extensions keep working on this computer; files move between them by themselves.
- `/ssh off` goes back to this computer; the chat continues.
- sudo asks them in pi each time, showing the command; Esc refuses.
- To remove it later, the README's **Uninstall** section has the steps.

## Check it worked

- pi's status line shows `ssh <name>:<folder>` (and the git branch, in a repository).
- `!hostname` prints the remote's name; `/ssh status` says where the chat works.

## Never do this

- Don't ask for, read, print or store a password. Don't read the saved passwords from the keychain.
- Don't add machines the user didn't name, or change a machine's `~/.ssh/authorized_keys` yourself.
- Don't turn on `modelTools` or `sudoRemember` unless the user asks.
- Don't accept a host key for the user, or edit `~/.ssh/known_hosts`.
- Don't publish, fork or re-upload this package on the user's behalf.
- Don't edit or delete pi's session files (`~/.pi/agent/sessions/`), not even to remove this extension's entries.

## Uninstalling

Goal: **nothing left behind** on this computer. Follow these steps in order. Don't improvise extra deletions.

### What the extension leaves on a computer

| What | Where | Removed by |
|---|---|---|
| The code | pi's package folder, plus an entry in `~/.pi/agent/settings.json` | `pi uninstall` |
| Settings, saved machines, recent connections, session folders, the debug log | `~/.pi/agent/pi-seamless-ssh/` | "Remove everything", or deleting the folder |
| Saved passwords | the macOS Keychain / Secret Service (or a private file in that folder) | "Remove everything" |
| Sockets, short-lived copies | `/tmp/pss-<uid>-<id>/`, `/dev/shm/pss-<uid>-<id>/` (Linux) | "Remove everything" (they're gone after a disconnect anyway) |
| Copies of it in npm's cache | `~/.npm/_cacache` | "Remove everything" (only its own entries) |

### Steps

1. **Look first, change nothing yet:** `pi list` (note the exact source), and whether pi runs while connected.
2. **Tell the user what will be removed and get a yes:** saved machines and saved passwords go; using it again means
   setting them up again.
3. **Clean up from inside pi.** Ask the user to close every other pi window. Then either the user runs `/ssh` →
   **[DANGER] › Remove everything…** (or types `/ssh remove`) and confirms, or you do it over RPC: start
   `pi --mode rpc` and send
   ```json
   {"id": "1", "type": "prompt", "message": "/ssh remove"}
   ```
   Answer its `"method": "confirm"` request (show the user its `title` and `message`) with
   `{"type": "extension_ui_response", "id": "<the request's id>", "confirmed": true}` only after their yes. The last
   `notify` starts with `pi-seamless-ssh removed.` and lists what was done: show it to them, then close stdin.
4. **Remove the code:** `pi uninstall <source from step 1>`, with pi not running.
5. **Verify, and show the user the output** (all empty):
   ```bash
   pi list | grep -i seamless-ssh
   ls -a ~/.pi/agent/pi-seamless-ssh
   ls -d /tmp/pss-* /dev/shm/pss-* 2>/dev/null
   ```

### What stays, on purpose; don't delete it

- **The remote machines:** each project's `.pi/agent` folder (its files and its AGENTS.md copy) belongs to the
  project. Key logins set up stay in that machine's `~/.ssh/authorized_keys`; remove the line only if the user asks.
- **The user's SSH key**, even if the extension made it (`~/.ssh/id_ed25519`): they may use it elsewhere.
- **`~/.ssh/known_hosts`:** ssh's own record of trusted machines.
- **pi's sessions:** chats that used `/ssh` hold small `pi-seamless-ssh` entries (which machine each point worked on).
  pi ignores them without the extension; never edit session files.

## Troubleshooting

See the README's **Troubleshooting** section.
