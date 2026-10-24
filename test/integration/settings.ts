// What the integration tests run against: your own machine and model, never a default. Give them in the environment
// or in test/integration/.env (git ignores it); the environment wins. See docs/TESTING.md.
//   IT_TARGET       the machine to test against, e.g. me@192.168.1.20 (it must log in without a password prompt)
//   IT_KEY          a private key for it, loaded into a throwaway ssh-agent (else this computer's own ssh setup is used)
//   IT_MODEL        provider/id of the model for the tests that ask a model
//   IT_EXTENSIONS   pi extensions that provide that model, comma-separated paths
//   IT_AGENT_FILES  files those extensions need in pi's agent folder (e.g. their settings), comma-separated paths

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

const file = new URL("./.env", import.meta.url).pathname;
if (existsSync(file)) process.loadEnvFile(file);

function need(name: string, what: string): string {
	const value = process.env[name]?.trim();
	if (value) return value;
	console.error(`Set ${name}: ${what}. In the environment or in test/integration/.env; see docs/TESTING.md.`);
	process.exit(2);
}

const list = (name: string): string[] => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The machine, as given to ssh and /ssh. */
export const target = (): string => need("IT_TARGET", "the machine to test against, e.g. me@192.168.1.20");

/** The model for the tests that ask one, and the extensions that provide it. */
export function model(): { provider: string; id: string; extensions: string[] } {
	const [provider, id] = need("IT_MODEL", "the model to use, as provider/id").split(/\/(.*)/s);
	if (!provider || !id) need("", "IT_MODEL as provider/id");
	return { provider: provider!, id: id!, extensions: list("IT_EXTENSIONS") };
}

/** Copies IT_AGENT_FILES into a test's own agent folder. */
export function agentFiles(dir: string): void {
	for (const f of list("IT_AGENT_FILES")) copyFileSync(f, join(dir, basename(f)));
}

/** The environment for ssh: with IT_KEY, a throwaway ssh-agent holding it (stop() ends it). */
export function sshEnv(): { env: NodeJS.ProcessEnv; stop(): void } {
	const key = process.env.IT_KEY;
	if (!key) return { env: { ...process.env }, stop: () => {} };
	const out = execFileSync("ssh-agent", ["-s"], { encoding: "utf8" });
	const sock = /SSH_AUTH_SOCK=([^;]+)/.exec(out)![1]!;
	const pid = Number(/SSH_AGENT_PID=(\d+)/.exec(out)![1]);
	const env = { ...process.env, SSH_AUTH_SOCK: sock };
	execFileSync("ssh-add", ["-q", key], { env, stdio: "ignore" });
	return {
		env,
		stop: () => {
			try {
				process.kill(pid);
			} catch {
				// Already gone.
			}
		},
	};
}
