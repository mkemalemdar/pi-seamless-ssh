// Opens a real connection, says where its control socket is, then waits forever: the parent test kills it with
// SIGKILL to prove the ssh master doesn't outlive the process that opened it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTarget, type Target } from "../../src/core/target.ts";
import { Connection } from "../../src/ssh/connection.ts";
import { target } from "./settings.ts";

const sock = join(mkdtempSync(join(tmpdir(), "pss-hold-")), "m.sock");
const conn = new Connection(parseTarget(target()) as Target, sock);
await conn.open();
process.stdout.write(`${sock}\n`);
setInterval(() => {}, 1 << 30);
