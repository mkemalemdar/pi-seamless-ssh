// The model switching machines by itself, against a real machine and model:
//   node test/integration/model-tools.mjs        (the machine and the model: IT_TARGET, IT_KEY, IT_MODEL…, see settings.ts)
// With "The model can switch machines" on: the model connects to the saved machine, runs pwd there, disconnects
// (told apart by the working folder, so the remote can be this same computer).
// With it off: the tools aren't offered to the model at all.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agentFiles, model, sshEnv, target } from "./settings.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const TARGET = target();
const { provider: PROVIDER, id: MODEL, extensions: EXTENSIONS } = model();
const results = [];
const check = (name, ok, detail = "") => {
	const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`;
	results.push(line);
	console.log(line);
};
const ssh = sshEnv();
const env = ssh.env;
const remoteHome = execFileSync("ssh", ["-o", "BatchMode=yes", TARGET, 'printf %s "$HOME"'], { env, encoding: "utf8" });
const project = `${remoteHome}/pss-model-it-${Date.now()}`;
execFileSync("ssh", ["-o", "BatchMode=yes", TARGET, `mkdir -p '${project}'`], { env, stdio: "ignore" });

async function run(modelTools, steps) {
	const dir = mkdtempSync(join(tmpdir(), "pss-model-"));
	mkdirSync(join(dir, "pi-seamless-ssh"), { recursive: true });
	mkdirSync(join(dir, "work"));
	writeFileSync(join(dir, "pi-seamless-ssh", "settings.json"), JSON.stringify({ modelTools, machines: [{ name: "vm", address: TARGET }], recent: [{ address: TARGET, project }] }));
	agentFiles(dir);
	const proc = spawn("pi", ["--mode", "rpc", "--no-session", "--extension", `${ROOT}src/index.ts`, ...EXTENSIONS.flatMap((e) => ["--extension", e]), "--extension", `${ROOT}test/integration/tree-probe.ts`], {
		cwd: join(dir, "work"),
		env: { ...env, PI_CODING_AGENT_DIR: dir },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const events = [];
	const pending = new Map();
	let seq = 0;
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
		if (msg.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(msg.method)) {
			proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: msg.id, cancelled: true })}\n`);
		}
		events.push(msg);
	});
	const send = (cmd) => {
		const id = `t${++seq}`;
		proc.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
		return new Promise((resolve) => pending.set(id, resolve));
	};
	const waitFor = async (pred, ms) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const hit = events.find(pred);
			if (hit) return hit;
			await new Promise((r) => setTimeout(r, 200));
		}
		return undefined;
	};
	const activeTools = async () => {
		const mark = events.length;
		await send({ type: "prompt", message: "/pss-tools" });
		const n = await waitFor((e) => events.indexOf(e) >= mark && e.type === "extension_ui_request" && e.method === "notify" && e.message?.startsWith("active tools:"), 10000);
		return (n?.message ?? "").slice("active tools: ".length).split(",");
	};
	try {
		await steps({ send, events, waitFor, activeTools, here: realpathSync(join(dir, "work")) });
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
	await run(false, async (pi) => {
		const tools = await pi.activeTools();
		check("setting off: the model isn't offered the switching tools", !tools.some((t) => t.startsWith("ssh_")) && tools.includes("bash"), tools.join(","));
	});
	await run(true, async (pi) => {
		const tools = await pi.activeTools();
		check("setting on: ssh_machines, ssh_connect, ssh_disconnect are offered", ["ssh_machines", "ssh_connect", "ssh_disconnect"].every((t) => tools.includes(t)), tools.join(","));
		await pi.send({ type: "set_model", provider: PROVIDER, modelId: MODEL });
		await pi.send({ type: "set_thinking_level", level: "low" });
		const mark = pi.events.length;
		await pi.send({ type: "prompt", message: "Use the ssh_connect tool to connect to the saved machine named vm. Then run `pwd` with the bash tool. Then use ssh_disconnect. Finally run `pwd` with bash once more. Reply with both outputs." });
		await pi.waitFor((e) => e.type === "agent_settled" && pi.events.indexOf(e) >= mark, 600000);
		const calls = pi.events.slice(mark).filter((e) => e.type === "tool_execution_end").map((e) => ({ tool: e.toolName, out: JSON.stringify(e.result?.content ?? "") }));
		const order = calls.map((c) => c.tool).join(" → ");
		const connectAt = calls.findIndex((c) => c.tool === "ssh_connect");
		const disconnectAt = calls.findIndex((c) => c.tool === "ssh_disconnect");
		const between = calls.slice(connectAt + 1, disconnectAt).filter((c) => c.tool === "bash");
		const after = calls.slice(disconnectAt + 1).filter((c) => c.tool === "bash");
		check("ssh_connect connected", connectAt >= 0 && /Connected to vm/.test(calls[connectAt]?.out ?? ""), calls[connectAt]?.out.slice(0, 160));
		check("bash after ssh_connect ran on the remote", between.length > 0 && between.every((c) => c.out.includes(project) && !c.out.includes(pi.here)), between.map((c) => c.out).join(" ").slice(0, 160));
		check("bash after ssh_disconnect ran on this computer", after.length > 0 && after.every((c) => c.out.includes(pi.here)), `${order} | ${after.map((c) => c.out).join(" ").slice(0, 120)}`);
	});
} catch (e) {
	check("ran", false, e.message);
} finally {
	try {
		execFileSync("ssh", ["-o", "BatchMode=yes", TARGET, `rm -rf '${project}'`], { env, stdio: "ignore" });
	} catch {}
	ssh.stop();
}
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
