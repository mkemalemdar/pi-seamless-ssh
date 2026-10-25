// The connection's folders outside pi's agent folder: named after this setup, and the socket folder removed once no
// connection uses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the socket folder goes once it's empty, and stays while a connection uses it", async (t) => {
	const agent = mkdtempSync(join(tmpdir(), "pss-runtime-"));
	t.after(() => rmSync(agent, { recursive: true, force: true }));
	process.env.PI_CODING_AGENT_DIR = agent;
	const { releaseSocketBase, socketBase } = await import("../src/runtime.ts");
	const dir = socketBase();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "open.sock"), "");
	releaseSocketBase();
	assert.ok(existsSync(join(dir, "open.sock")), "a connection still uses it");
	rmSync(join(dir, "open.sock"));
	releaseSocketBase();
	assert.ok(!existsSync(dir), "empty: removed");
	releaseSocketBase();
});
