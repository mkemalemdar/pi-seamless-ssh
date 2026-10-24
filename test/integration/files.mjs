// Files between home extensions and the remote, through a real pi and its hooks, with a model:
//   1. a WhatsApp-style photo arrives on home → it must land in the remote project's .pi, home keeps a placeholder,
//      and the model must see (and use) the remote path;
//   2. the model makes a file on the remote and sends it with a home tool → the tool must get the real bytes.
// The WhatsApp stand-in (fake-whatsapp.ts) does both the way pi-harness-whatsapp does.
//   node test/integration/files.mjs        (the machine and the model: IT_TARGET, IT_KEY, IT_MODEL…, see settings.ts)

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agentFiles, model, sshEnv as startSsh, target } from "./settings.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const TARGET = target();
const M = model();
const results = [];
const check = (name, ok, detail = "") => {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`;
  results.push(line);
  console.log(line);
};

const ssh = startSsh();
const sshEnv = ssh.env;
const onRemote = (cmd) => execFileSync("ssh", ["-o", "BatchMode=yes", TARGET, cmd], { env: sshEnv, encoding: "utf8" });

const dir = mkdtempSync(join(tmpdir(), "pss-files-"));
const work = join(dir, "work");
mkdirSync(work);
const waLog = join(dir, "fake-wa.jsonl");
const src = process.env.PI_CODING_AGENT_DIR;
if (src && existsSync(join(src, "auth.json"))) cpSync(join(src, "auth.json"), join(dir, "auth.json"));
agentFiles(dir);

const proc = spawn("pi", ["--mode", "rpc", "--no-session",
  "--extension", `${ROOT}src/index.ts`,
  ...M.extensions.flatMap((e) => ["--extension", e]),
  "--extension", `${ROOT}test/integration/fake-whatsapp.ts`,
], { cwd: work, env: { ...sshEnv, PI_CODING_AGENT_DIR: dir, FAKE_WA_LOG: waLog }, stdio: ["pipe", "pipe", "pipe"] });
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
const settledAfter = (mark, ms = 600000) => waitFor((e) => e.type === "agent_settled" && events.indexOf(e) >= mark, ms);
const toolCallsAfter = (mark) => events.slice(mark).filter((e) => e.type === "tool_execution_start");
const waEntries = () => (existsSync(waLog) ? readFileSync(waLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const notes = () => events.filter((e) => e.type === "extension_ui_request" && e.method === "notify").map((e) => e.message);

const project = `pss-files-it-${Date.now()}`;
onRemote(`mkdir -p ~/${project}`);
const remoteHome = onRemote("printf %s \"$HOME\"");
const remoteProject = `${remoteHome}/${project}`;
const homeInboxFile = join(dir, "pi-harness-whatsapp", "inbox", "photo-from-ali.png");
const remoteInboxFile = `${remoteProject}/.pi/agent/pi-harness-whatsapp/inbox/photo-from-ali.png`;

try {
  await send({ type: "prompt", message: `/ssh ${TARGET} ~/${project}` });
  const connected = await waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /Connected to|Couldn't|isn't|refused|lacks/.test(e.message ?? ""), 40000);
  check("connected", /Connected to/.test(connected?.message ?? ""), connected?.message);

  const models = (await send({ type: "get_available_models" })).data?.models ?? [];
  const { provider, id } = M;
  const m = models.find((x) => x.provider === provider && x.id === id);
  if (!m) throw new Error(`model ${provider}/${id} not available: ${models.map((x) => x.id).join(", ")}`);
  await send({ type: "set_model", provider: m.provider, modelId: m.id });
  await send({ type: "set_thinking_level", level: "low" });

  // ---- 1. a photo arrives
  let mark = events.length;
  await send({ type: "prompt", message: "/fakewa-photo" });
  await settledAfter(mark);
  const remoteSize = onRemote(`wc -c < '${remoteInboxFile}' 2>/dev/null || echo missing`).trim();
  check("the received photo is in the remote project's .pi", remoteSize === "70", `remote size: ${remoteSize}`);
  const homeBytes = existsSync(homeInboxFile) ? readFileSync(homeInboxFile) : undefined;
  check("home keeps a placeholder (same size, no data)", !!homeBytes && statSync(homeInboxFile).size === 70 && homeBytes.every((b) => b === 0), homeBytes ? `${homeBytes.length} bytes, all zero: ${homeBytes.every((b) => b === 0)}` : "missing");
  const calls1 = toolCallsAfter(mark).filter((e) => e.toolName === "bash").map((e) => e.args?.command ?? "");
  check("the model used the remote path, never the home one", calls1.some((c) => c.includes(remoteInboxFile) || c.includes(".pi/agent/pi-harness-whatsapp/inbox/photo-from-ali.png")) && !calls1.some((c) => c.includes(dir)), calls1.join(" ;; ").slice(0, 300));
  const results1 = events.slice(mark).filter((e) => e.type === "tool_execution_end" && e.toolName === "bash").map((e) => JSON.stringify(e.result?.content ?? "")).join(" ");
  check("the model's `file` / `wc` on the remote saw the real PNG", /PNG image/.test(results1) && /70/.test(results1), results1.slice(0, 300));

  // ---- 2. the model makes a file on the remote and sends it with the home tool
  mark = events.length;
  await send({ type: "prompt", message: "Run this exact bash command: printf 'made-on-the-remote' > reply.txt\nThen send reply.txt to me with the whatsapp_send_image tool (path: reply.txt). Do nothing else." });
  await settledAfter(mark);
  const sent = waEntries().filter((e) => e.sent);
  const last = sent.at(-1);
  check("the home tool got the real bytes of the remote file", last?.text === "made-on-the-remote", JSON.stringify(last ?? waEntries()));
  check("the home tool's copy is gone after the call", !!last && !existsSync(last.opened), last?.opened);

  // ---- 3. back home
  await send({ type: "prompt", message: "/ssh off" });
  await waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /Disconnected/.test(e.message ?? ""), 20000);
  check("after /ssh off the placeholder is gone from home", !existsSync(homeInboxFile));
  check("the remote keeps the photo", onRemote(`wc -c < '${remoteInboxFile}'`).trim() === "70");
} catch (e) {
  check("ran", false, e.message);
} finally {
  proc.stdin.end();
  await new Promise((r) => {
    const t = setTimeout(() => (proc.kill("SIGTERM"), r()), 5000);
    proc.on("exit", () => (clearTimeout(t), r()));
  });
  try {
    onRemote(`rm -rf ~/${project}`);
  } catch {}
  ssh.stop();
  if (results.some((r) => r.startsWith("FAIL"))) console.log(`\nnotes: ${notes().join(" | ")}\npi stderr:\n${stderr.slice(-1500)}`);
  rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
