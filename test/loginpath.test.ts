// The login PATH: read once from your login shell, then every script (the model's commands too) starts with it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLoginPath } from "../src/core/loginpath.ts";
import { remoteBashOps } from "../src/routed/bash.ts";
import { localRemote } from "./local-remote.ts";

const root = mkdtempSync(join(tmpdir(), "pss-path-"));
after(() => rmSync(root, { recursive: true, force: true }));
const own = join(root, "my bin");
mkdirSync(own);
const exe = (path: string, lines: string[]) => {
	writeFileSync(path, `${lines.join("\n")}\n`);
	chmodSync(path, 0o755);
	return path;
};
exe(join(own, "hello-login"), ["#!/bin/sh", "echo found-through-login-path"]);
// A login shell whose startup adds a folder of your own and prints things around the command, like a real one can.
const shells = {
	good: exe(join(root, "good-shell"), [
		"#!/bin/sh",
		'echo "Welcome banner"',
		'[ "$1" = -l ] && [ "$2" = -i ] && [ "$3" = -c ] || exit 9',
		`PATH=${JSON.stringify(own)}:"$PATH"; export PATH`,
		'echo "noise from the rc file"',
		'eval "$4"',
		'echo "goodbye"',
	]),
	hangs: exe(join(root, "hanging-shell"), ["#!/bin/sh", "exec sleep 30"]),
	silent: exe(join(root, "silent-shell"), ["#!/bin/sh", "exit 0"]),
};

async function machine(shell: string) {
	const { conn, remote } = await localRemote();
	conn.env = { ...process.env, SHELL: shell };
	return { conn, remote };
}

const run = async (remote: Awaited<ReturnType<typeof machine>>["remote"], command: string) => {
	let out = "";
	const r = await remoteBashOps(() => remote).exec(command, root, { onData: (d) => (out += d.toString()) });
	return { out, code: r.exitCode };
};

test("your login's PATH is read once (startup noise ignored) and the model's commands find your own programs", async () => {
	const { conn, remote } = await machine(shells.good);
	assert.notEqual((await run(remote, "hello-login")).code, 0, "before: not found, as over plain SSH");
	assert.equal(await remote.useLoginPath(), undefined);
	assert.equal(conn.loginPath?.split(":")[0], own, "your folder first, as your login has it");
	const { out, code } = await run(remote, "hello-login");
	assert.equal(code, 0);
	assert.equal(out, "found-through-login-path\n");
	const seen = (await run(remote, "printenv PATH")).out.trim().split(":");
	// The call's own sudo stand-in comes first, then your login's PATH.
	assert.deepEqual(seen.slice(1), conn.loginPath!.split(":"));
	assert.equal(new Set(seen).size, seen.length, "each folder once");
	for (const dir of process.env.PATH!.split(":")) assert.ok(seen.includes(dir), `the plain PATH's ${dir} is kept`);
});

test("no PATH to be had: the reason, and the plain PATH stays", async () => {
	for (const [shell, why] of [
		[shells.hangs, /didn't finish within 1 s/],
		[shells.silent, /didn't give a PATH/],
		// (An unset $SHELL can't be tested the same everywhere: macOS's sh fills it in from your account.)
		[join(root, "no-such-shell"), /login shell \(\$SHELL\) isn't set or isn't there/],
	] as const) {
		const { conn, remote } = await machine(shell);
		const t0 = Date.now();
		assert.match((await remote.useLoginPath(1)) ?? "", why);
		assert.ok(Date.now() - t0 < 5000, "a hanging startup is stopped");
		assert.equal(conn.loginPath, undefined);
		assert.equal((await run(remote, "echo still-works")).out, "still-works\n");
	}
});

test("the PATH goes in front of the script exactly, whatever it contains; nothing when there is none", () => {
	const script = "echo hi";
	assert.equal(withLoginPath(script, undefined), script);
	assert.equal(withLoginPath(script, "/a b/it's:/usr/bin"), `PATH='/a b/it'\\''s:/usr/bin'; export PATH\necho hi`);
});
