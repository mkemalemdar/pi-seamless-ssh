// Before the first connection the extension takes over nothing: none of pi's tools are registered at load (the
// integration test test/integration/pi.mjs checks the rest with a real pi: taken over on connect, pi's own again in a
// new chat).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("loading the extension registers none of pi's tools; only its own (hidden) model tools", async (t) => {
	const agent = mkdtempSync(join(tmpdir(), "pss-takeover-"));
	t.after(() => rmSync(agent, { recursive: true, force: true }));
	process.env.PI_CODING_AGENT_DIR = agent;
	const { default: extension } = await import("../src/index.ts");
	const { ROUTED } = await import("../src/routed/tools.ts");
	const registered: string[] = [];
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (tool: { name: string }) => void registered.push(tool.name),
		getActiveTools: () => [],
		setActiveTools: () => {},
		getAllTools: () => [],
		appendEntry: () => {},
	};
	extension(pi as never);
	assert.deepEqual(registered.filter((name) => (ROUTED as readonly string[]).includes(name)), [], "none of read, write, edit, bash, grep, find, ls");
	assert.ok(registered.every((name) => name.startsWith("ssh_")), registered.join(", "));
});
