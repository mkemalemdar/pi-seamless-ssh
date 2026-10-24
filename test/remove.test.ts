// "Remove everything", in a throwaway agent folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainUnlocked } from "../src/ssh/keyring.ts";

test("Remove everything deletes the extension's folder and its saved passwords, then refuses to connect", async (t) => {
	const agent = mkdtempSync(join(tmpdir(), "pss-remove-"));
	process.env.PI_CODING_AGENT_DIR = agent;
	// Its own npm cache, so the real one is never touched.
	process.env.npm_config_cache = join(agent, "npm-cache");
	const { Controller } = await import("../src/controller.ts");
	const { socketBase } = await import("../src/runtime.ts");
	// Another pi setup on this computer (another agent folder), connected right now: its folders must stay.
	process.env.PI_CODING_AGENT_DIR = join(agent, "another-setup");
	const theirs = socketBase();
	process.env.PI_CODING_AGENT_DIR = agent;
	const mine = socketBase();
	assert.notEqual(theirs, mine);
	mkdirSync(theirs, { recursive: true });
	writeFileSync(join(theirs, "live.sock"), "");
	mkdirSync(mine, { recursive: true });
	const c = new Controller({ getAllTools: () => [], appendEntry: () => {}, getActiveTools: () => [], setActiveTools: () => {} } as never);
	mkdirSync(join(c.dir, "session", "x"), { recursive: true });
	writeFileSync(join(c.dir, "debug.log"), "log");
	c.settings.machines = [{ name: "vm", address: "pss-remove-test@example" }];
	c.saveSettings();
	const store = await c.passwordStore();
	// Over SSH the Mac's Keychain is locked: no password can be saved there, so only that part is left out.
	const withPassword = !store.where.includes("Keychain") || (await keychainUnlocked());
	if (withPassword) {
		await store.set("pss-remove-test@example", "secret");
		c.settings.savedPasswords = ["pss-remove-test@example"];
	} else t.diagnostic("the Keychain is locked here (not the Mac's desktop session): saved passwords not checked");
	const notes: string[] = [];
	const ctx = { hasUI: false, ui: { notify: (m: string) => notes.push(m), setStatus: () => {} } } as never;
	const lines = await c.removeEverything(ctx);
	assert.ok(!existsSync(c.dir), "the folder is gone");
	assert.ok(!existsSync(mine), "this setup's socket folder is gone");
	assert.ok(existsSync(join(theirs, "live.sock")), "another setup's connection is left alone");
	rmSync(theirs, { recursive: true, force: true });
	if (withPassword) {
		assert.equal(await store.get("pss-remove-test@example"), undefined, "the saved password is gone");
		assert.match(lines.join("\n"), /Removed 1 saved password/);
	}
	assert.match(lines.join("\n"), /npm's cache/);
	assert.match(lines.at(-1)!, /pi uninstall npm:pi-seamless-ssh/);
	assert.match((await c.removeEverything(ctx)).join("\n"), /already removed/);
	// pi loading the extension again (/reload) gets a controller that stays inert too.
	const again = new Controller({ getAllTools: () => [], appendEntry: () => {}, getActiveTools: () => [], setActiveTools: () => {} } as never);
	assert.equal(again.removed, true);
	again.saveSettings();
	assert.ok(!existsSync(again.dir), "a reloaded extension writes nothing either");
	let failed = "";
	await c.connect(ctx, "vm", "/x", { step() {}, password: async () => undefined, trustHost: async () => false, pickFolder: async () => undefined, failed: async (m) => void (failed = m), done() {}, cancelled() {}, onCancel() {} });
	assert.match(failed, /were removed/);
	c.saveSettings();
	assert.ok(!existsSync(c.dir), "nothing is written again");
	rmSync(agent, { recursive: true, force: true });
});
