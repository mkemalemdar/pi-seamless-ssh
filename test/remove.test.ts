// "Remove everything", in a throwaway agent folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainUnlocked } from "../src/ssh/keyring.ts";

test("Remove everything deletes the extension's folder and its saved passwords, then refuses to connect", async (t) => {
  const agent = mkdtempSync(join(tmpdir(), "pss-remove-"));
  process.env.PI_CODING_AGENT_DIR = agent;
  const { Controller } = await import("../src/controller.ts");
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
  if (withPassword) {
    assert.equal(await store.get("pss-remove-test@example"), undefined, "the saved password is gone");
    assert.match(lines.join("\n"), /Removed 1 saved password/);
  }
  assert.match(lines.at(-1)!, /pi uninstall npm:pi-seamless-ssh/);
  let failed = "";
  await c.connect(ctx, "vm", "/x", { step() {}, password: async () => undefined, trustHost: async () => false, pickFolder: async () => undefined, failed: async (m) => void (failed = m), done() {}, cancelled() {}, onCancel() {} });
  assert.match(failed, /were removed/);
  c.saveSettings();
  assert.ok(!existsSync(c.dir), "nothing is written again");
});
