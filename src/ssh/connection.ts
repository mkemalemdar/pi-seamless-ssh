// One shared SSH connection per machine, owned by pi: the system's own `ssh` keeps a master connection open and
// every command, copy and port forward rides on it, so you log in once. The master ends when pi ends (it isn't left
// running), and a dead connection is noticed within about 30 s even while idle.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import type { Target } from "../core/target.ts";
import { classifySsh, type SshProblem } from "../core/errors.ts";
import { withLoginPath } from "../core/loginpath.ts";
import type { Askpass } from "./askpass.ts";
import { firstLine, log } from "../log.ts";

/** Raised when the connection is gone: nothing was run. */
export class ConnectionLost extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectionLost";
	}
}

export interface RunResult {
	code: number | null;
	stdout: Buffer;
	stderr: string;
}

export interface RunOptions {
	/** Data for the script's commands to read (e.g. `cat > file`, `tar -xf -`). Without it the input ends right after the script, so nothing waits for typing. */
	input?: Buffer | string | Readable;
	/** Live output, for bash. */
	onStdout?: (chunk: Buffer) => void;
	/** The output piped (with flow control) into a stream, which is ended when the output ends. */
	stdoutTo?: Writable;
	onStderr?: (chunk: string) => void;
	signal?: AbortSignal;
}

const CONNECT_SECONDS = 10;

/**
 * The only command line the remote's login shell ever sees: read the script's length, read exactly that many bytes
 * (dd one byte at a time, so nothing more is taken from the input), run them. No newlines and only single quotes, so
 * sh, bash, zsh, fish, tcsh and nushell all pass it to /bin/sh unchanged.
 */
export const BOOTSTRAP = `/bin/sh -c 'read n; s=$(dd bs=1 count=$n 2>/dev/null); eval "$s"'`;

/** The script as the bootstrap reads it: its length in bytes, a newline, the script. */
export const framed = (script: string): Buffer => {
	const body = Buffer.from(script, "utf8");
	return Buffer.concat([Buffer.from(`${body.length}\n`), body]);
};

export class Connection {
	readonly target: Target;
	readonly controlPath: string;
	/** A password (or passphrase) was typed for this connection: reconnecting needs a person. */
	usedPrompt = false;
	/** Your login shell's PATH on the machine: every script starts with it (see core/loginpath.ts). */
	loginPath: string | undefined;
	private master: ChildProcess | undefined;
	private closing = false;
	/** Set by {@link cancel}: the connection attempt under way stops. */
	private cancelled = false;
	private dropHandler: ((problem: SshProblem) => void) | undefined;

	constructor(target: Target, controlPath: string) {
		this.target = target;
		this.controlPath = controlPath;
	}

	get machine(): string {
		return this.target.label;
	}

	/** Called once when the connection dies on its own (not when closed). */
	onDrop(handler: (problem: SshProblem) => void): void {
		this.dropHandler = handler;
	}

	isAlive(): boolean {
		return !!this.master && this.master.exitCode === null && this.master.signalCode === null && existsSync(this.controlPath);
	}

	private base(): string[] {
		return ["-S", this.controlPath, ...(this.target.port ? ["-p", String(this.target.port)] : [])];
	}

	/**
	 * Opens the master connection. With `askpass`, ssh may ask for a password or a new host key through pi's
	 * dialogs; without it (automatic reconnects) only keys and the agent are tried.
	 */
	async open(askpass?: Askpass): Promise<void> {
		this.closing = false;
		this.cancelled = false;
		log("ssh", `connecting to ${this.machine}${askpass ? "" : " (no person: keys, agent, saved password)"}`);
		const args = [
			"-M",
			"-N",
			...this.base(),
			"-o", "ControlPersist=no",
			"-o", "ServerAliveInterval=10",
			"-o", "ServerAliveCountMax=3",
			"-o", `ConnectTimeout=${CONNECT_SECONDS}`,
			"-o", "NumberOfPasswordPrompts=3",
			"-o", "ExitOnForwardFailure=no",
			...(askpass ? [] : ["-o", "BatchMode=yes"]),
			"--",
			this.target.destination,
		];
		const env = { ...process.env, ...(askpass ? askpass.env() : {}) };
		if (!askpass) delete env.SSH_ASKPASS_REQUIRE;
		// The master runs under a small watcher holding a pipe from pi: when pi ends in any way (even killed), the pipe
		// closes and the watcher ends ssh, so no connection is ever left running. ssh's own exit (a drop) still ends the
		// watcher, with ssh's exit code and messages.
		const child = spawn("/bin/sh", ["-c", WATCHER, "pss-ssh", ...args], { stdio: ["pipe", "ignore", "pipe"], env });
		child.stdin?.on("error", () => {});
		this.master = child;
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < 8000) stderr += chunk;
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let waited = 0;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearInterval(timer);
				if (error) reject(error);
				else resolve();
			};
			child.once("error", (e) => finish(new Error(`ssh couldn't start: ${e.message}`)));
			child.once("close", () => finish(this.cancelled ? new Cancelled() : new SshError(classifySsh(stderr, this.machine))));
			// Ready once the control socket answers. The time limit pauses while a password dialog is open.
			const timer = setInterval(() => {
				if (askpass?.pending) return;
				waited += 200;
				if (waited > (CONNECT_SECONDS + 5) * 1000) {
					child.kill("SIGKILL");
					finish(new SshError({ message: `${this.machine} didn't answer in time.`, retry: true }));
					return;
				}
				if (existsSync(this.controlPath)) {
					this.check().then((ok) => ok && finish(), () => {});
				}
			}, 200);
		});
		log("ssh", `connected to ${this.machine}`);
		child.removeAllListeners("close");
		child.once("close", () => {
			if (this.closing) return;
			const problem = classifySsh(stderr, this.machine);
			log("ssh", `connection to ${this.machine} dropped: ${problem.message}`);
			this.dropHandler?.(problem);
		});
	}

	/** Whether the master answers. */
	check(): Promise<boolean> {
		return new Promise((resolve) => {
			const c = spawn("ssh", [...this.base(), "-O", "check", "--", this.target.destination], { stdio: "ignore" });
			c.once("error", () => resolve(false));
			c.once("close", (code) => resolve(code === 0));
		});
	}

	/**
	 * Runs a POSIX shell script on the remote over the shared connection.
	 *
	 * ssh is given one fixed command, {@link BOOTSTRAP}; the script and then any data follow on its input. So:
	 * - whatever the remote login shell is (bash, zsh, fish, tcsh…), it only ever parses that one fixed line;
	 * - the script's text is in no process's argument list (`pkill -f` can't hit it, `ps` doesn't show it);
	 * - the script is read by its exact length, so data after it is untouched for the script's commands. (A shell
	 *   reading its script straight from input, `sh -s`, isn't safe: dash reads ahead and swallows the data.)
	 */
	run(script: string, options: RunOptions = {}): Promise<RunResult> {
		if (!this.isAlive()) return Promise.reject(new ConnectionLost(`The connection to ${this.machine} is down, so nothing was run.`));
		const started = Date.now();
		log("run", firstLine(script));
		return new Promise((resolve, reject) => {
			const args = [...this.base(), "-o", "BatchMode=yes", "-o", "ControlMaster=no", "--", this.target.destination, BOOTSTRAP];
			const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
			const out: Buffer[] = [];
			let err = "";
			if (options.stdoutTo) child.stdout.pipe(options.stdoutTo);
			else
				child.stdout.on("data", (chunk: Buffer) => {
					if (options.onStdout) options.onStdout(chunk);
					else out.push(chunk);
				});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				options.onStderr?.(chunk);
				if (err.length < 64_000) err += chunk;
			});
			const onAbort = () => child.kill("SIGTERM");
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.once("error", (e) => reject(new Error(`ssh couldn't start: ${e.message}`)));
			child.once("close", (code) => {
				options.signal?.removeEventListener("abort", onAbort);
				// 255 is ssh's own failure; with the master gone it means the connection dropped mid-command.
				if (code === 255 && !this.isAlive()) {
					reject(new ConnectionLost(`The connection to ${this.machine} was lost; the command may have run partly.`));
					return;
				}
				if (code !== 0) log("run", `exit ${code} after ${Date.now() - started} ms: ${firstLine(err)}`);
				resolve({ code, stdout: Buffer.concat(out), stderr: err });
			});
			child.stdin.on("error", () => {});
			const head = framed(withLoginPath(script, this.loginPath));
			const input = options.input;
			if (input === undefined) child.stdin.end(head);
			else if (typeof input === "string" || Buffer.isBuffer(input)) {
				child.stdin.write(head);
				child.stdin.end(input);
			} else {
				child.stdin.write(head);
				input.once("error", (e) => {
					child.kill("SIGTERM");
					reject(e);
				});
				input.pipe(child.stdin);
			}
		});
	}

	/** Adds a port forward to the shared connection: home `localPort` → the remote's `remotePort`. */
	async forward(localPort: number, remotePort: number): Promise<void> {
		const code = await new Promise<number | null>((resolve) => {
			const c = spawn("ssh", [...this.base(), "-O", "forward", "-L", `127.0.0.1:${localPort}:localhost:${remotePort}`, "--", this.target.destination], { stdio: "ignore" });
			c.once("error", () => resolve(null));
			c.once("close", resolve);
		});
		if (code !== 0) throw new Error(`couldn't forward port ${remotePort} from ${this.machine}`);
	}

	/** Stops a connection attempt at once (Esc while connecting, or a cancelled password): ssh is ended, not asked again. */
	cancel(): void {
		log("ssh", `connection attempt to ${this.machine} stopped`);
		this.cancelled = true;
		this.closing = true;
		this.master?.stdin?.end();
	}

	/** Removes a port forward added with {@link forward}. */
	async cancelForward(localPort: number, remotePort: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const c = spawn("ssh", [...this.base(), "-O", "cancel", "-L", `127.0.0.1:${localPort}:localhost:${remotePort}`, "--", this.target.destination], { stdio: "ignore" });
			c.once("error", () => resolve());
			c.once("close", () => resolve());
		});
	}

	/** Ends the connection (and its forwards). */
	async close(): Promise<void> {
		log("ssh", `closing the connection to ${this.machine}`);
		this.closing = true;
		const master = this.master;
		this.master = undefined;
		if (!master || master.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const c = spawn("ssh", [...this.base(), "-O", "exit", "--", this.target.destination], { stdio: "ignore" });
			c.once("error", () => resolve());
			c.once("close", () => resolve());
		});
		// Closing the watcher's pipe ends ssh if `-O exit` didn't.
		master.stdin?.end();
	}
}

/**
 * Runs `ssh "$@"` and ends it when its input (the pipe from pi) closes. The pipe is kept on fd 3 because a background
 * job's input would otherwise be /dev/null. Exits with ssh's code.
 */
const WATCHER = `exec 3<&0; ssh "$@" < /dev/null & p=$!; ( read _ <&3; kill $p 2>/dev/null ) & r=$!; wait $p; c=$?; kill $r 2>/dev/null; exit $c`;

/** The user stopped the connection attempt. */
export class Cancelled extends Error {
	constructor() {
		super("cancelled");
		this.name = "Cancelled";
	}
}

export class SshError extends Error {
	readonly problem: SshProblem;
	constructor(problem: SshProblem) {
		super(problem.message);
		this.name = "SshError";
		this.problem = problem;
	}
}

/** Closes a master left behind by a pi that crashed. */
export function closeLeftover(controlPath: string, destination: string, port?: number): Promise<void> {
	return new Promise((resolve) => {
		if (!existsSync(controlPath)) return resolve();
		const c = spawn("ssh", ["-S", controlPath, ...(port ? ["-p", String(port)] : []), "-O", "exit", "--", destination], { stdio: "ignore" });
		c.once("error", () => resolve());
		c.once("close", () => resolve());
	});
}
