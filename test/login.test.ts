// The password screen, saved passwords, and key login setup (in a throwaway home folder: the real ~/.ssh is never touched).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, keychainUnlocked, passwordStore } from "../src/ssh/keyring.ts";
import { installKey, localPublicKey } from "../src/ssh/keysetup.ts";
import { PasswordPrompt, type PasswordAnswer } from "../src/ui/password.ts";
import { localRemote } from "./local-remote.ts";

const made: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "pss-login-"));
	made.push(d);
	return d;
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const K = { down: "\x1b[B", up: "\x1b[A", enter: "\r", esc: "\x1b", space: " " };

test("password screen: typing (spaces too), one box or none, Enter answers, Esc cancels", () => {
	let answer: PasswordAnswer | undefined;
	let cancelled = false;
	const p = new PasswordPrompt(theme, "vm", "me@vm's password:", { offerKeep: true, where: "in the macOS Keychain" }, (a) => (answer = a), () => (cancelled = true));
	for (const ch of "se cret") p.handleInput(ch);
	assert.ok(p.render(80).some((l) => l.includes("•••••••")), "dots, never the text");
	assert.ok(!p.render(80).some((l) => l.includes("se cret")));
	p.handleInput(K.down);
	p.handleInput(K.space);
	assert.ok(p.render(80).some((l) => l.includes("[x] Save the password")));
	p.handleInput(K.down);
	p.handleInput(K.space);
	const screen = p.render(80).join("\n");
	assert.match(screen, /\[ \] Save the password/, "ticking the other box unticks the first");
	assert.match(screen, /\[x\] Set up key login on vm/);
	p.handleInput(K.space);
	assert.doesNotMatch(p.render(80).join("\n"), /\[x\]/, "and it can be unticked: none");
	p.handleInput(K.space);
	p.handleInput(K.enter);
	assert.deepEqual(answer, { password: "se cret", keep: "key" });

	const q = new PasswordPrompt(theme, "vm", "", { offerKeep: true, preset: "password", where: "x" }, () => {}, () => (cancelled = true));
	assert.match(q.render(80).join("\n"), /\[x\] Save the password/, "a saved machine's choice starts ticked");
	q.handleInput(K.esc);
	assert.ok(cancelled);
});

test("saved passwords in the file store: stored and read back by account, then removed; private file", async () => {
	const dir = tmp();
	const store = fileStore(dir);
	await store.set("me@vm", "pa ss'\"word");
	assert.equal(await store.get("me@vm"), "pa ss'\"word");
	assert.equal(statSync(join(dir, "passwords.json")).mode & 0o777, 0o600);
	await store.remove("me@vm");
	assert.equal(await store.get("me@vm"), undefined);
});

test("saved passwords in this computer's own store (when it has a usable one)", async (t) => {
	const store = await passwordStore(tmp());
	if (store.where.includes("Keychain") && !(await keychainUnlocked())) return t.skip("the Keychain is locked here (not the Mac's desktop session)");
	const account = `pss-test-${process.pid}@example`;
	await store.set(account, "pa ss'\"word");
	assert.equal(await store.get(account), "pa ss'\"word");
	await store.remove(account);
	assert.equal(await store.get(account), undefined);
});

test("key login: this computer's key is made when missing and added to the machine once, with sshd's permissions", async () => {
	const home = tmp();
	const remoteHome = tmp();
	const realHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const first = localPublicKey();
		assert.ok(first.made && first.key.startsWith("ssh-ed25519 "));
		assert.ok(existsSync(join(home, ".ssh", "id_ed25519")));
		assert.equal(localPublicKey().made, false, "an existing key is reused");
		const { conn, remote } = await localRemote();
		conn.env = { ...process.env, HOME: remoteHome };
		await installKey(remote, first.key);
		await installKey(remote, first.key);
		const keys = readFileSync(join(remoteHome, ".ssh", "authorized_keys"), "utf8");
		assert.equal(keys, `${first.key}\n`, "added once");
		assert.equal(statSync(join(remoteHome, ".ssh")).mode & 0o777, 0o700);
		assert.equal(statSync(join(remoteHome, ".ssh", "authorized_keys")).mode & 0o777, 0o600);
	} finally {
		process.env.HOME = realHome;
	}
});
