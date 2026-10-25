// A real pi (the dev pi, in RPC mode) with the extension, against a real machine.
//   node test/integration/pi.mjs [model]        (the machine: IT_TARGET, IT_KEY; with "model": IT_MODEL…, see settings.ts)
// Without arguments: connect, `!` commands, the status line, disconnect. With "model" it also asks the model to run
// `hostname` and checks the answer came from the remote.
// Prints PASS / FAIL per check.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agentFiles, model, sshEnv, target } from "./settings.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const TARGET = target();
const WITH_MODEL = process.argv.includes("model");
const M = WITH_MODEL ? model() : undefined;
const results = [];
const check = (name, ok, detail = "") => {
	const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`;
	results.push(line);
	console.log(line);
};

const ssh = sshEnv();

const dir = mkdtempSync(join(tmpdir(), "pss-pi-"));
const work = join(dir, "work");
mkdirSync(work);
const src = process.env.PI_CODING_AGENT_DIR;
if (src && existsSync(join(src, "auth.json"))) cpSync(join(src, "auth.json"), join(dir, "auth.json"));
const extensions = ["--extension", `${ROOT}src/index.ts`, "--extension", `${ROOT}test/integration/tree-probe.ts`];
if (M) {
	agentFiles(dir);
	for (const e of M.extensions) extensions.push("--extension", e);
}

const proc = spawn("pi", ["--mode", "rpc", "--no-session", ...extensions], {
	cwd: work,
	env: { ...ssh.env, PI_CODING_AGENT_DIR: dir },
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
proc.stderr.on("data", (d) => (stderr += d));
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
const waitFor = async (pred, ms = 30000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const hit = events.find(pred);
		if (hit) return hit;
		await new Promise((r) => setTimeout(r, 100));
	}
	return undefined;
};
const notes = () => events.filter((e) => e.type === "extension_ui_request" && e.method === "notify").map((e) => e.message);
/** Where pi's bash comes from right now: pi's own ("builtin:…") or this extension's file. */
const bashSource = async () => {
	const mark = events.length;
	await send({ type: "prompt", message: "/pss-source bash" });
	const hit = await waitFor((e) => events.indexOf(e) >= mark && e.type === "extension_ui_request" && e.method === "notify" && e.message?.startsWith("source bash:"), 10000);
	return hit?.message?.slice("source bash: ".length) ?? "";
};
const ours = (source) => source.startsWith(`${ROOT}src/`);
const statuses = () => events.filter((e) => e.type === "extension_ui_request" && e.method === "setStatus" && e.statusKey === "ssh").map((e) => e.statusText ?? "");

const project = `pss-pi-it-${Date.now()}`;
execFileSync("ssh", ["-o", "BatchMode=yes", TARGET, `mkdir -p ~/${project}`], { env: ssh.env, stdio: "ignore" });
try {
	await send({ type: "get_state" });
	const cmds = (await send({ type: "get_commands" })).data?.commands ?? [];
	check("/ssh is registered", cmds.some((c) => c.name === "ssh"));
	const before = await bashSource();
	check("before /ssh, pi's tools are pi's own (nothing taken over)", before.startsWith("builtin:"), before);

	await send({ type: "prompt", message: `/ssh ${TARGET} ~/${project}` });
	const connected = await waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /Connected to|Couldn't|isn't|refused|lacks/.test(e.message ?? ""), 40000);
	check("connects with /ssh <machine> <folder>", /Connected to/.test(connected?.message ?? ""), connected?.message ?? notes().join(" | "));
	check("the status line shows the machine", statuses().some((s) => s.includes(TARGET)), statuses().join(" | "));

	const connectedSource = await bashSource();
	check("connecting takes over pi's tools", ours(connectedSource), connectedSource);
	// Told apart by the working folder (the project on the remote, pi's own folder at home), so this also works
	// when the remote is this same computer.
	const bash = await send({ type: "bash", command: "hostname; pwd" });
	const out = String(bash.data?.output ?? "");
	check("! commands run on the remote, in the project", out.includes(project) && !out.includes(realpathSync(work)), out.trim().replace(/\n/g, " | "));

	if (WITH_MODEL) {
		const models = (await send({ type: "get_available_models" })).data?.models ?? [];
		const { provider, id } = M;
		const m = models.find((x) => x.provider === provider && x.id === id);
		if (!m) check("model available", false, models.map((x) => x.id).join(", "));
		else {
			await send({ type: "set_model", provider: m.provider, modelId: m.id });
			await send({ type: "set_thinking_level", level: "low" });
			const mark = events.length;
			await send({ type: "prompt", message: "Run `hostname` and `pwd` with the bash tool, then reply with exactly the two output lines." });
			await waitFor((e) => e.type === "agent_settled" && events.indexOf(e) >= mark, 600000);
			// The model may run the two commands in one call or in two: look at all of its bash calls in this turn.
			const calls = events.slice(mark).filter((e) => e.type === "tool_execution_end" && e.toolName === "bash");
			const toolOut = calls.map((e) => JSON.stringify(e.result?.content ?? "")).join(" ");
			const remoteHost = out.trim().split("\n")[0];
			check("the model's bash runs on the remote, in the project", calls.length > 0 && !toolOut.includes(work) && toolOut.includes(remoteHost) && toolOut.includes(project), toolOut.slice(0, 300));
		}
	}

	await send({ type: "prompt", message: "/ssh off" });
	const off = await waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /Disconnected/.test(e.message ?? ""), 20000);
	check("/ssh off goes home", !!off, notes().join(" | "));
	const home = await send({ type: "bash", command: "pwd" });
	check("! commands run at home again", String(home.data?.output ?? "").trim() === realpathSync(work), String(home.data?.output ?? "").trim());
	const offSource = await bashSource();
	check("after /ssh off the tools stay taken over (pi can't hand them back), passing through to pi's own", ours(offSource), offSource);
	await send({ type: "new_session" });
	await new Promise((r) => setTimeout(r, 1500));
	const fresh = await bashSource();
	check("a new chat loads the extension fresh: pi's own tools again", fresh.startsWith("builtin:"), fresh);
} catch (e) {
	check("ran", false, e.message);
} finally {
	proc.stdin.end();
	await new Promise((r) => {
		const t = setTimeout(() => (proc.kill("SIGTERM"), r()), 5000);
		proc.on("exit", () => (clearTimeout(t), r()));
	});
	try {
		execFileSync("ssh", ["-o", "BatchMode=yes", TARGET, `rm -rf ~/${project}`], { env: ssh.env, stdio: "ignore" });
	} catch {}
	ssh.stop();
	rmSync(dir, { recursive: true, force: true });
	if (results.some((r) => r.startsWith("FAIL")) && stderr) console.log(`\npi stderr:\n${stderr.slice(-2000)}`);
}
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
