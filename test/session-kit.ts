// Builds a Session for tests: `home` and `remote project` are given folders (or temp folders); the connection is a
// stand-in or a real one.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EXACT_NAMES, type NameRules } from "../src/core/names.ts";
import type { Workspace } from "../src/core/paths.ts";
import type { Connection } from "../src/ssh/connection.ts";
import type { Remote } from "../src/ssh/remote.ts";
import { RecordStore } from "../src/sync/record.ts";
import { Scratch } from "../src/sync/scratch.ts";
import { Session } from "../src/sync/session.ts";
import { Askpass } from "../src/ssh/askpass.ts";

/** Every scratch space a test made: removed by {@link removeTestSessions}, whether or not the test closed its session. */
const scratches: Scratch[] = [];
export const removeTestSessions = (): void => scratches.splice(0).forEach((s) => s.remove());

export function makeSession(conn: Connection, remote: Remote, ws: Workspace, options: { names?: NameRules; id?: string } = {}) {
  const id = options.id ?? `t${process.pid}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const store = new RecordStore(join(ws.homeAgent, "pi-seamless-ssh"));
  const sessionDir = join(ws.homeAgent, "pi-seamless-ssh", "session", id);
  mkdirSync(sessionDir, { recursive: true });
  const scratch = new Scratch(id, join(sessionDir, "scratch"));
  scratches.push(scratch);
  store.start({ version: 1, pid: process.pid, machine: "test", destination: "test", controlPath: "/x", project: ws.remoteProject, remoteHome: ws.remoteHome, sessionId: id, placeholders: {}, setAside: {}, createdDirs: [] });
  const notes: string[] = [];
  const session = new Session({
    conn,
    remote,
    ws,
    store,
    sessionDir,
    scratch,
    localPorts: [],
    names: options.names ?? EXACT_NAMES,
    hooks: {
      notify: (m) => notes.push(m),
      changed: () => {},
      askReconnect: async () => "home",
      // No person in tests: a login helper that answers no question (key logins need none).
      askpass: async () => {
        const askpass = new Askpass(join(sessionDir, "bin"), sessionDir, "t", async () => undefined);
        await askpass.start();
        return askpass;
      },
    },
  });
  return { session, store, notes, scratch, sessionDir };
}
