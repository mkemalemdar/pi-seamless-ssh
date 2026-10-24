// pi's read, write, edit, bash, grep, find and ls, registered under their own names. At home they are pi's own tools,
// unchanged. While connected they do their work on the remote, in the project. When the connection is down they refuse
// with a plain message, so nothing ever runs on home files by mistake.

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Session } from "../sync/session.ts";
import { remoteBashOps, type SudoAsk } from "./bash.ts";
import { remoteGrep, type GrepParams } from "./grep.ts";
import { editOps, findOps, lsOps, readOps, writeOps } from "./ops.ts";

export const ROUTED = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
/** Routed tools that only read: after them nothing on the remote or home can have changed. */
export const READ_ONLY = new Set<string>(["read", "grep", "find", "ls"]);

/** The context a tool sees, with the remote project as its working folder (keeps everything else of pi's context). */
const remoteCtx = <C extends object>(ctx: C, cwd: string): C => Object.create(ctx, { cwd: { value: cwd, enumerable: true } }) as C;

export function registerRouted(pi: ExtensionAPI, session: () => Session | undefined, sudo?: SudoAsk): void {
	const home = process.cwd();
	const usable = () => {
		const s = session();
		if (!s) return undefined;
		if (!s.usable) throw new Error(notUsable(s));
		return s;
	};
	const remote = () => session()!.remote;

	type Def = ReturnType<typeof createReadToolDefinition>;
	const route = (local: Def, makeRemote: (cwd: string) => Def) => {
		pi.registerTool({
			...local,
			async execute(id, params, signal, onUpdate, ctx) {
				const s = usable();
				if (!s) return local.execute(id, params, signal, onUpdate, ctx);
				const cwd = s.ws.remoteProject;
				return makeRemote(cwd).execute(id, params, signal, onUpdate, remoteCtx(ctx, cwd));
			},
		} as Def);
	};

	route(createReadToolDefinition(home), (cwd) => createReadToolDefinition(cwd, { operations: readOps(remote) }));
	route(createWriteToolDefinition(home) as unknown as Def, (cwd) => createWriteToolDefinition(cwd, { operations: writeOps(remote) }) as unknown as Def);
	route(createEditToolDefinition(home) as unknown as Def, (cwd) => createEditToolDefinition(cwd, { operations: editOps(remote) }) as unknown as Def);
	route(createBashToolDefinition(home) as unknown as Def, (cwd) => createBashToolDefinition(cwd, { operations: remoteBashOps(remote, sudo) }) as unknown as Def);
	route(createFindToolDefinition(home) as unknown as Def, (cwd) => createFindToolDefinition(cwd, { operations: findOps(remote) }) as unknown as Def);
	route(createLsToolDefinition(home) as unknown as Def, (cwd) => createLsToolDefinition(cwd, { operations: lsOps(remote) }) as unknown as Def);

	// pi's grep searches with ripgrep on home, so its search is replaced while connected.
	const grep = createGrepToolDefinition(home);
	pi.registerTool({
		...grep,
		async execute(id, params, signal, onUpdate, ctx) {
			const s = usable();
			if (!s) return grep.execute(id, params, signal, onUpdate, ctx);
			const p = params as GrepParams;
			const path = p.path ? (p.path.startsWith("/") ? p.path : `${s.ws.remoteProject}/${p.path}`) : s.ws.remoteProject;
			return { content: [{ type: "text" as const, text: await remoteGrep(s.remote, p, path) }], details: undefined };
		},
	} as typeof grep);

	// `!command` typed by the user runs on the remote too.
	pi.on("user_bash", () => {
		const s = session();
		if (!s) return undefined;
		// The chat works on the remote: never on this computer instead.
		if (!s.usable) return { result: { output: notUsable(s), exitCode: undefined, cancelled: true, truncated: false } };
		// pi hands over its home working folder; the command runs in the remote project instead.
		const ops = remoteBashOps(remote, sudo);
		// It may switch the project's git branch (shown in the status line).
		return { operations: { exec: (command, _cwd, options) => ops.exec(command, s.ws.remoteProject, options).finally(() => void s.refreshBranch()) } };
	});
}

/** Why nothing was run: the connection is being restored, or lost. */
function notUsable(s: Session): string {
	return s.state === "reconnecting"
		? `The connection to ${s.machine} dropped; reconnecting. Nothing was run.`
		: `The connection to ${s.machine} is lost. Nothing was run. Use /ssh to reconnect or go home.`;
}
