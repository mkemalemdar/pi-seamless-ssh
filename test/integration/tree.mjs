// Moving in the chat tree (/tree) against a real machine: the chat follows each point's machine.
//   node test/integration/tree.mjs        (the machine: IT_TARGET and IT_KEY, see settings.ts)
// Points: A on this computer → connect → B on the remote. Going back to A disconnects; going to B reconnects (with
// "reconnect automatically"); with "ask me", a yes switches and a no leaves it.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { sshEnv, target } from "./settings.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const TARGET = target();
const results = [];
const check = (name, ok, detail = "") => {
	const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`;
	results.push(line);
	console.log(line);
};
const ssh = sshEnv();
const env = ssh.env;
const project = `pss-tree-it-${Date.now()}`;
execFileSync("ssh", ["-o", "BatchMode=yes", TARGET, `mkdir -p ~/${project}`], { env, stdio: "ignore" });

async function run(reopen, steps) {
	const dir = mkdtempSync(join(tmpdir(), "pss-tree-"));
	mkdirSync(join(dir, "pi-seamless-ssh"), { recursive: true });
	writeFileSync(join(dir, "pi-seamless-ssh", "settings.json"), JSON.stringify({ reopen }));
	mkdirSync(join(dir, "work"));
	const proc = spawn("pi", ["--mode", "rpc", "--no-session", "--extension", `${ROOT}src/index.ts`, "--extension", `${ROOT}test/integration/tree-probe.ts`], {
		cwd: join(dir, "work"),
		env: { ...env, PI_CODING_AGENT_DIR: dir },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const events = [];
	const pending = new Map();
	let seq = 0;
	let confirmAnswer = false;
	createInterface({ input: proc.stdout }).on("line", (line) => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.type === "response" && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
			return;
		}
		if (msg.type === "extension_ui_request" && msg.method === "confirm") {
			proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: msg.id, confirmed: confirmAnswer })}\n`);
		} else if (msg.type === "extension_ui_request" && ["select", "input", "editor"].includes(msg.method)) {
			proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: msg.id, cancelled: true })}\n`);
		}
		events.push(msg);
	});
	const send = (cmd) => {
		const id = `t${++seq}`;
		proc.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
		return new Promise((resolve) => pending.set(id, resolve));
	};
	// Where `!` commands run, told by the working folder (pi's own folder here, the project on the remote), so this
	// also works when the remote is this same computer.
	const host = async () => String((await send({ type: "bash", command: "pwd" })).data?.output ?? "").trim();
	const settle = () => new Promise((r) => setTimeout(r, 2500));
	const here = realpathSync(join(dir, "work"));
	const api = {
		here,
		send,
		host,
		settle,
		answer: (yes) => (confirmAnswer = yes),
		lastEntryId: async () => (await send({ type: "get_entries" })).data?.entries?.at(-1)?.id,
		goTo: async (id) => {
			await send({ type: "prompt", message: `/pss-tree ${id}` });
			await settle();
		},
	};
	try {
		await steps(api);
	} finally {
		proc.stdin.end();
		await new Promise((r) => {
			const t = setTimeout(() => (proc.kill("SIGTERM"), r()), 5000);
			proc.on("exit", () => (clearTimeout(t), r()));
		});
		rmSync(dir, { recursive: true, force: true });
	}
}

try {
	await run("reconnect", async (pi) => {
		check("point A runs on this computer", (await pi.host()) === pi.here);
		const a = await pi.lastEntryId();
		await pi.send({ type: "prompt", message: `/ssh ${TARGET} ~/${project}` });
		await pi.settle();
		const remoteHost = await pi.host();
		check("point B runs on the remote", remoteHost !== pi.here && remoteHost.endsWith(project), remoteHost);
		const b = await pi.lastEntryId();
		await pi.goTo(a);
		check("back to A (before connecting): the chat is on this computer again", (await pi.host()) === pi.here);
		await pi.goTo(b);
		check("on to B again: the chat reconnects to the remote by itself", (await pi.host()) === remoteHost);
	});
	await run("ask", async (pi) => {
		const a = await pi.lastEntryId();
		await pi.send({ type: "prompt", message: `/ssh ${TARGET} ~/${project}` });
		await pi.settle();
		const b = await pi.lastEntryId();
		pi.answer(false);
		await pi.goTo(a);
		check("'ask me', answered no: it stays connected", (await pi.host()) !== pi.here);
		pi.answer(true);
		await pi.goTo(a);
		check("'ask me', answered yes: back on this computer", (await pi.host()) === pi.here);
		await pi.goTo(b);
		check("'ask me', yes, to B: connected again", (await pi.host()) !== pi.here);
	});
	await run("home", async (pi) => {
		const a = await pi.lastEntryId();
		await pi.send({ type: "prompt", message: `/ssh ${TARGET} ~/${project}` });
		await pi.settle();
		await pi.goTo(a);
		check("'don't reconnect': moving in the tree leaves the connection as it is", (await pi.host()) !== pi.here);
	});
} catch (e) {
	check("ran", false, e.message);
} finally {
	try {
		execFileSync("ssh", ["-o", "BatchMode=yes", TARGET, `rm -rf ~/${project}`], { env, stdio: "ignore" });
	} catch {}
	ssh.stop();
}
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
