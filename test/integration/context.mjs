// The model's instructions and the git branch while connected, against a real machine and model:
//   node test/integration/context.mjs        (the machine and the model: IT_TARGET, IT_KEY, IT_MODEL…, see settings.ts)
// This computer's AGENTS.md is copied to the project once; the model gets that copy and the project's own AGENTS.md;
// an edit to the copy applies on the next run; connecting again keeps the edited copy; the branch is in the status line.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const agent = sshEnv();
const env = agent.env;
const ssh = (cmd) => execFileSync("ssh", ["-o", "BatchMode=yes", TARGET, cmd], { env, encoding: "utf8" });
const remoteHome = ssh('printf %s "$HOME"');
const project = `${remoteHome}/pss-context-it-${Date.now()}`;
const copy = `${project}/.pi/agent/AGENTS.md`;
const HOME_WORD = `HOMEWORD${Date.now() % 100000}`;
const PROJECT_WORD = `PROJECTWORD${Date.now() % 99991}`;
const EDITED_WORD = `EDITEDWORD${Date.now() % 99989}`;
ssh(`mkdir -p '${project}' && cd '${project}' && git init -q -b pss-first 2>/dev/null || { git init -q && git checkout -q -b pss-first; }; printf '# Project\\nThis project is called ${PROJECT_WORD}.\\n' > AGENTS.md`);

const agentDir = mkdtempSync(join(tmpdir(), "pss-context-"));
mkdirSync(join(agentDir, "pi-seamless-ssh"), { recursive: true });
mkdirSync(join(agentDir, "work"));
writeFileSync(join(agentDir, "AGENTS.md"), `# Global\nOur build server is called ${HOME_WORD}.\n`);
writeFileSync(join(agentDir, "pi-seamless-ssh", "settings.json"), JSON.stringify({}));
agentFiles(agentDir);
const probe = join(agentDir, "prompts.txt");

async function run(steps) {
  const proc = spawn("pi", ["--mode", "rpc", "--no-session", "--extension", `${ROOT}src/index.ts`, ...EXTENSIONS.flatMap((e) => ["--extension", e]), "--extension", `${ROOT}test/integration/tree-probe.ts`], {
    cwd: join(agentDir, "work"),
    env: { ...env, PI_CODING_AGENT_DIR: agentDir, PSS_PROBE_PROMPT: probe },
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
  const waitFor = async (pred, from, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    return undefined;
  };
  const status = (from) => events.slice(from).filter((e) => e.method === "setStatus" && e.statusKey === "ssh").at(-1)?.statusText ?? "";
  const api = {
    send,
    status,
    connect: async () => {
      const mark = events.length;
      await send({ type: "prompt", message: `/ssh ${TARGET} ${project}` });
      const done = await waitFor((e) => e.method === "notify" && /^Connected to /.test(e.message ?? ""), mark, 60000);
      return done ? status(mark) : undefined;
    },
    /** One model run; its reply text. */
    ask: async (message) => {
      const mark = events.length;
      await send({ type: "prompt", message });
      await waitFor((e) => e.type === "agent_settled", mark, 600000);
      return events.slice(mark).filter((e) => e.type === "message_end" && e.message?.role === "assistant")
        .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : [])).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    },
    mark: () => events.length,
  };
  try {
    await send({ type: "set_model", provider: PROVIDER, modelId: MODEL });
    await send({ type: "set_thinking_level", level: "low" });
    await steps(api);
  } finally {
    proc.stdin.end();
    await new Promise((r) => {
      const t = setTimeout(() => (proc.kill("SIGTERM"), r()), 5000);
      proc.on("exit", () => (clearTimeout(t), r()));
    });
  }
}
const lastPrompt = () => (existsSync(probe) ? readFileSync(probe, "utf8").split("<<<END>>>\n").filter(Boolean).at(-1) ?? "" : "");

try {
  await run(async (pi) => {
    const connected = await pi.connect();
    check("connected", Boolean(connected), connected);
    check("the status line shows the git branch right after connecting (a new repository, no commits)", /\(pss-first\)/.test(connected ?? ""), connected);
    check("this computer's AGENTS.md was copied to the project", ssh(`cat '${copy}'`).includes(HOME_WORD));
    const reply = await pi.ask("What is our build server called, and what is this project called? Reply with just the two names.");
    const prompt = lastPrompt();
    check("the model gets the project's copy and the project's AGENTS.md", prompt.includes(copy) && prompt.includes(`${project}/AGENTS.md`) && prompt.includes(HOME_WORD) && prompt.includes(PROJECT_WORD), prompt.slice(0, 0));
    check("this computer's AGENTS.md itself isn't given to the model", !prompt.includes(join(agentDir, "AGENTS.md")));
    check("the model answers from them", reply.includes(HOME_WORD) && reply.includes(PROJECT_WORD), reply.slice(0, 160));

    ssh(`sed -i 's/${HOME_WORD}/${EDITED_WORD}/' '${copy}' && cd '${project}' && git checkout -q -b pss-second`);
    const mark = pi.mark();
    await pi.ask("Reply with OK.");
    check("an edit to the copy applies on the next run", lastPrompt().includes(EDITED_WORD) && !lastPrompt().includes(HOME_WORD));
    check("a branch switched elsewhere shows on the next run", /\(pss-second\)/.test(pi.status(mark)), pi.status(mark));

    const bashMark = pi.mark();
    await pi.send({ type: "bash", command: "git checkout -q -b pss-third" });
    await new Promise((r) => setTimeout(r, 2000));
    check("a branch switched with !command shows at once", /\(pss-third\)/.test(pi.status(bashMark)), pi.status(bashMark));
    await pi.send({ type: "prompt", message: "/ssh off" });
  });
  await run(async (pi) => {
    const connected = await pi.connect();
    check("connected again", Boolean(connected));
    check("connecting again keeps the edited copy", ssh(`cat '${copy}'`).includes(EDITED_WORD) && !ssh(`cat '${copy}'`).includes(HOME_WORD));
    await pi.ask("Reply with OK.");
    check("…and the model gets the edited copy", lastPrompt().includes(EDITED_WORD));
    await pi.send({ type: "prompt", message: "/ssh off" });
  });
} catch (e) {
  check("ran", false, e.message);
} finally {
  try {
    ssh(`rm -rf '${project}'`);
  } catch {}
  rmSync(agentDir, { recursive: true, force: true });
  agent.stop();
}
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
