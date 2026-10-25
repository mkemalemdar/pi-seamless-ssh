# Testing

## Unit tests

```bash
npm run check     # typecheck + unit tests
```

They need no second machine: `test/local-remote.ts` runs the remote scripts with this computer's own `/bin/sh`,
exactly as a real connection would, so bash calls, listings, transfers, sudo (with a stand-in sudo) and the login
PATH (with stand-in login shells) all run for real. GitHub runs them on Linux and macOS for every push.

A test that needs something the computer doesn't have skips itself, and says why (e.g. a locked macOS Keychain when
pi runs over SSH).

## Integration tests

Against a real machine over SSH, and some with a real model. Nothing has a default: give your own machine and
model, in the environment or in `test/integration/.env` (git ignores it; the environment wins).

| Variable | What |
|---|---|
| `IT_TARGET` | the machine, e.g. `me@192.168.1.20`, or this same computer (`me@localhost`, with a key whose `authorized_keys` line starts `from="127.0.0.1,::1"`); it must log in without a password prompt |
| `IT_KEY` | a private key for it, loaded into a throwaway ssh-agent (otherwise your own ssh setup is used) |
| `IT_MODEL` | `provider/id` of the model, for the tests that ask one |
| `IT_EXTENSIONS` | pi extensions that provide that model, comma-separated paths |
| `IT_AGENT_FILES` | files they need in pi's agent folder (their settings), comma-separated paths |

```bash
# test/integration/.env
IT_TARGET=me@192.168.1.20
IT_KEY=/home/me/.ssh/test_key
IT_MODEL=myserver/my-model
IT_EXTENSIONS=/home/me/src/my-provider-extension/index.ts
IT_AGENT_FILES=/home/me/test-settings/provider.json
```

| Test | Needs | Checks |
|---|---|---|
| `node --test --experimental-strip-types test/integration/vm.test.ts` | machine | the shared connection, bash and Esc, port forwards, no ssh left after `kill -9`, the login PATH, real sudo (refused only, so no wrong password is ever tried), placeholders, a drop and a reconnect |
| `node test/integration/tree.mjs` | machine | `/tree` and reopening chats: reconnect, ask, don't reconnect |
| `node test/integration/pi.mjs [model]` | machine (+ model) | a real pi in RPC mode: connect, `!commands`, the status line, disconnect; with `model`, the model's bash runs on the remote |
| `node test/integration/files.mjs` | machine + model | a WhatsApp-style extension (`fake-whatsapp.ts`): a photo lands on the remote, a remote file is sent by a home tool |
| `node test/integration/model-tools.mjs` | machine + model | the model connecting and disconnecting by itself, and the setting that hides those tools |
| `node test/integration/context.mjs` | machine + model | the AGENTS.md copy and its edits, the project's instructions, the git branch |

Each test works in a scratch folder on the remote (`~/pss-…-<time>`) and removes it, and stops every process it
started. Model tests use a low thinking level and short prompts.
