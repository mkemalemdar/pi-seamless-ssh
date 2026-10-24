// Against a real machine over SSH (the machine: IT_TARGET and IT_KEY, see settings.ts).
//   node --test --experimental-strip-types test/integration/vm.test.ts
// Everything happens in a scratch folder ~/pss-it-<time> on the remote, removed at the end.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseTarget, type Target } from "../../src/core/target.ts";
import type { Workspace } from "../../src/core/paths.ts";
import { remoteBashOps } from "../../src/routed/bash.ts";
import { Connection } from "../../src/ssh/connection.ts";
import { Remote } from "../../src/ssh/remote.ts";
import { makeSession, removeTestSessions } from "../session-kit.ts";
import { sshEnv, target as targetText } from "./settings.ts";

const target = parseTarget(targetText()) as Target;
let ssh: ReturnType<typeof sshEnv> | undefined;
let conn: Connection;
let remote: Remote;
let project = "";
const local = mkdtempSync(join(tmpdir(), "pss-it-"));

before(async () => {
	ssh = sshEnv();
	process.env.SSH_AUTH_SOCK = ssh.env.SSH_AUTH_SOCK;
	mkdirSync(join(local, "sock"), { mode: 0o700 });
	conn = new Connection(target, join(local, "sock", "m.sock"));
	await conn.open();
	remote = new Remote(conn);
	await remote.probe();
	project = `${remote.info.home}/pss-it-${Date.now()}`;
	await remote.mkdirp(`${project}/.pi/agent`);
});

after(async () => {
	if (conn?.isAlive()) {
		await remote.sh(`rm -rf -- '${project}'`).catch(() => {});
		await conn.close();
	}
	ssh?.stop();
	removeTestSessions();
	rmSync(local, { recursive: true, force: true });
});

test("the shared connection: one login, then commands ride on it", async () => {
	assert.ok(conn.isAlive());
	assert.ok(await conn.check());
	assert.equal(remote.info.os, "linux");
	assert.deepEqual(remote.info.missing, []);
	const t0 = Date.now();
	for (let i = 0; i < 5; i++) await remote.sh("true");
	assert.ok(Date.now() - t0 < 3000, `5 commands took ${Date.now() - t0} ms`);
});

test("bash runs on the remote, in the project, and background programs survive the call", async () => {
	const ops = remoteBashOps(() => remote);
	let out = "";
	const r = await ops.exec("hostname; pwd; (sleep 2; echo ok > bg.txt) &", project, { onData: (d) => (out += d.toString()) });
	assert.equal(r.exitCode, 0);
	assert.match(out, new RegExp(`${project}`));
	assert.notEqual(out.split("\n")[0], execFileSync("hostname", { encoding: "utf8" }).trim(), "ran on the remote, not here");
	await new Promise((res) => setTimeout(res, 2500));
	assert.equal((await remote.readFile(`${project}/bg.txt`)).toString(), "ok\n");
});

test("Esc stops the remote command and its children", async () => {
	const ops = remoteBashOps(() => remote);
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 800);
	await assert.rejects(ops.exec("(sleep 3; echo leaked > leak.txt) & sleep 30", project, { onData: () => {}, signal: ac.signal }), /aborted/);
	await new Promise((res) => setTimeout(res, 3500));
	assert.equal(await remote.test("-e", `${project}/leak.txt`), false);
});

test("a port forward on the shared connection reaches a server on the remote's localhost", async () => {
	const ops = remoteBashOps(() => remote);
	await ops.exec("cd /tmp && (python3 -m http.server 38123 --bind 127.0.0.1 > /dev/null 2>&1 &) ; sleep 1", project, { onData: () => {} });
	try {
		await conn.forward(38124, 38123);
		const res = await fetch("http://127.0.0.1:38124/");
		assert.equal(res.status, 200);
	} finally {
		await ops.exec("pkill -f 'http.server 38123' || true", project, { onData: () => {} });
	}
});

test("the master connection doesn't outlive the process that opened it, even when that is killed (kill -9)", async () => {
	const child = spawn(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "hold-connection.ts")], { stdio: ["ignore", "pipe", "ignore"], env: process.env });
	const sock = await new Promise<string>((resolve) => child.stdout!.once("data", (d: Buffer) => resolve(d.toString().trim())));
	// pgrep called directly (not through sh -c, whose own arguments would match the pattern).
	const masters = () => {
		try {
			return execFileSync("pgrep", ["-f", "--", `-S ${sock}`], { encoding: "utf8" }).trim();
		} catch {
			return "";
		}
	};
	assert.notEqual(masters(), "", "the master runs while its process lives");
	child.kill("SIGKILL");
	const t0 = Date.now();
	while (masters() !== "" && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
	assert.equal(masters(), "", `the master ended ${Date.now() - t0} ms after its process was killed`);
	// The killed helper couldn't remove its own folder.
	rmSync(dirname(sock), { recursive: true, force: true });
});

test("your login's PATH on the machine: read once, then the model's commands find what your terminal finds", async () => {
	// Over plain SSH, folders your login adds (here ~/.local/bin, which Ubuntu's ~/.profile adds when it exists) are missing.
	const own = `${remote.info.home}/.local/bin`;
	const ownExists = await remote.test("-d", own);
	assert.equal(await remote.useLoginPath(), undefined);
	let out = "";
	await remoteBashOps(() => remote).exec("printenv PATH", project, { onData: (d) => (out += d.toString()) });
	const seen = out.trim().split(":");
	assert.equal(new Set(seen).size, seen.length, "each folder once");
	if (ownExists) assert.ok(seen.includes(own), `${own} is in ${out}`);
	assert.ok(seen.includes("/usr/bin"));
});

test("real sudo asks this computer through the helper; refusing stops it (no password is tried)", async () => {
	const seen: string[] = [];
	let out = "";
	const ops = remoteBashOps(() => remote, async (r) => {
		seen.push(r.prompt);
		return undefined;
	});
	// -k: ignore a cached sudo login, so sudo always asks.
	const result = await ops.exec("sudo -k echo should-not-run", project, { onData: (d) => (out += d.toString()) });
	if (seen.length === 0 && result.exitCode === 0) return; // this account needs no sudo password
	assert.equal(seen.length, 1, out);
	assert.match(seen[0]!, /password/i);
	assert.notEqual(result.exitCode, 0);
	assert.doesNotMatch(out, /should-not-run/);
	assert.equal((await remote.sh("ls -d \"${TMPDIR:-/tmp}\"/pss-run.* 2>/dev/null; true")).toString().trim(), "", "the call's folder is gone");
});

test("the session: placeholders, a mentioned file moving over, a remote file sent by a home tool, then a drop and a reconnect", async () => {
	const homeAgent = join(local, "agent");
	mkdirSync(homeAgent, { recursive: true });
	const ws: Workspace = { homeAgent, homeHome: local, remoteProject: project, remoteHome: remote.info.home };
	const { session, notes } = makeSession(conn, remote, ws);

	// A file already in the project's .pi shows up as a placeholder.
	await remote.writeFile(`${project}/.pi/agent/pi-harness-whatsapp/inbox/old.jpg`, "x").catch(async () => {
		await remote.mkdirp(`${project}/.pi/agent/pi-harness-whatsapp/inbox`);
		await remote.writeFile(`${project}/.pi/agent/pi-harness-whatsapp/inbox/old.jpg`, "remote-old");
	});
	await session.sweep();
	const ph = join(homeAgent, "pi-harness-whatsapp", "inbox", "old.jpg");
	assert.ok(existsSync(ph));
	assert.ok(readFileSync(ph).every((b) => b === 0));

	// A WhatsApp-style file mentioned in a message moves to the remote.
	const photo = join(homeAgent, "pi-harness-whatsapp", "inbox", "new.jpg");
	writeFileSync(photo, "new-photo");
	await session.moveMentioned(`saved at ${photo}]`);
	assert.equal((await remote.readFile(`${project}/.pi/agent/pi-harness-whatsapp/inbox/new.jpg`)).toString(), "new-photo");

	// A home tool given a remote file gets the real content for the call.
	await remote.writeFile(`${project}/shot.png`, "png");
	const input: Record<string, unknown> = { path: "shot.png" };
	await session.prepareCall("c1", input);
	assert.equal(readFileSync(input.path as string, "utf8"), "png");
	await session.finishCall("c1", "sent");

	// Deleting a placeholder deletes the remote file.
	unlinkSync(ph);
	await session.sweep();
	assert.equal(await remote.test("-e", `${project}/.pi/agent/pi-harness-whatsapp/inbox/old.jpg`), false);

	// Drop: the master is told to exit; with a key the session reconnects by itself.
	execFileSync("ssh", ["-S", conn.controlPath, "-O", "exit", "--", target.destination], { stdio: "ignore" });
	await new Promise((res) => setTimeout(res, 300));
	assert.equal(session.usable, false);
	const t0 = Date.now();
	while (!session.usable && Date.now() - t0 < 15000) await new Promise((res) => setTimeout(res, 200));
	assert.ok(session.usable, `reconnected (${Date.now() - t0} ms); notes: ${notes.join(" | ")}`);
	assert.ok(notes.some((n) => n.startsWith("Reconnected")));

	// Disconnect: home is as before, the remote keeps its files.
	await session.close();
	conn = new Connection(target, join(local, "sock", "m2.sock"));
	await conn.open();
	remote = new Remote(conn);
	await remote.probe();
	assert.ok(!existsSync(join(homeAgent, "pi-harness-whatsapp", "inbox", "new.jpg")) || statSync(join(homeAgent, "pi-harness-whatsapp", "inbox", "new.jpg")).size === 0);
	assert.equal((await remote.readFile(`${project}/.pi/agent/pi-harness-whatsapp/inbox/new.jpg`)).toString(), "new-photo");
});
