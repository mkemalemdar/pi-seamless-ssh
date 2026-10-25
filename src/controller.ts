// Connecting, picking the project, switching, disconnecting, reopening a chat, and cleaning up after a crash.
// What is shown while connecting goes through a ConnectUI: the /ssh panel, or plain dialogs without pi's terminal UI.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { shortPath } from "./core/browser.ts";
import { CONTEXT_NAMES } from "./core/context.ts";
import { remoteAgent, type Workspace } from "./core/paths.ts";
import { addressFor, defaultSettings, type Keep, nameFor, normalizeSettings, rememberConnection, type Settings } from "./core/settings.ts";
import { parseTarget, sshConfigHosts, type Target } from "./core/target.ts";
import type { SudoRequest } from "./routed/bash.ts";
import { ROUTED } from "./routed/tools.ts";
import { Askpass, isHostKeyQuestion } from "./ssh/askpass.ts";
import { Cancelled, closeLeftover, Connection, SshError } from "./ssh/connection.ts";
import { passwordStore, type PasswordStore } from "./ssh/keyring.ts";
import { installKey, localPublicKey } from "./ssh/keysetup.ts";
import { Remote } from "./ssh/remote.ts";
import { detectNameRules } from "./sync/home.ts";
import { pidAlive, RecordStore } from "./sync/record.ts";
import { Scratch } from "./sync/scratch.ts";
import { Session, SLOW_MS, type Transfer, undoHomeChanges } from "./sync/session.ts";
import { type ConnectUI, dialogUI } from "./ui/connect-ui.ts";
import { applyModelTools } from "./model-tools.ts";
import { cleanNpmCache } from "./cleanup/npm-cache.ts";
import { isRemoved, markRemoved } from "./removed.ts";
import { releaseSocketBase, runtimeFolders, socketBase } from "./runtime.ts";
import { saveJson } from "./store.ts";
import { SudoPasswords } from "./sudo.ts";
import { PasswordPrompt } from "./ui/password.ts";

export const ENTRY = "pi-seamless-ssh";
/** This package's folder (where npm installed it). */
const packageRoot = (): string => join(dirname(fileURLToPath(import.meta.url)), "..");

/** What "Remove everything" does, shown before it's confirmed (in the panel, and for /ssh remove). */
export function removalDetails(dir: string): string {
	return [
		"This can't be undone. It:",
		"• disconnects, if connected",
		`• deletes ${dir}: settings, saved machines, recent connections, session folders, the debug log`,
		"• removes the passwords saved for your machines from this computer's keychain",
		"• deletes its sockets and RAM copies, and its copies in npm's download cache",
		"",
		"It doesn't touch the remote machines: each project's .pi/agent folder stays there, and key logins set up stay in their ~/.ssh/authorized_keys (remove the line by hand if you want).",
		"",
		"Close any other pi windows that use it first, so they can't write files again.",
		`Afterwards: ${UNINSTALL_HINT}`,
	].join("\n");
}

export const UNINSTALL_HINT = "quit pi and run `pi uninstall npm:pi-seamless-ssh` (or the source `pi list` shows).";
const STATUS = "ssh";

/** What happened at the password prompt of one connection attempt. */
interface LoginState {
	/** The password typed (kept only until it's saved or dropped). */
	typed?: string;
	keep?: Keep;
	usedSaved?: boolean;
	/** The saved password was tried and ssh asked again. */
	savedFailed: boolean;
}

/** What a chat remembers about its connection (a custom entry in the chat file). */
export interface ChatEntry {
	machine: string | null;
	project?: string;
}

export class Controller {
	readonly pi: ExtensionAPI;
	readonly dir = join(getAgentDir(), "pi-seamless-ssh");
	readonly store = new RecordStore(this.dir);
	settings: Settings = defaultSettings();
	session: Session | undefined;
	/** The latest context pi gave us, for dialogs outside a command (a dropped connection). */
	private ctx: ExtensionContext | undefined;
	private busy = false;
	/** "Remove everything" ran (in this pi process, also before a /reload): the extension does nothing more. */
	get removed(): boolean {
		return isRemoved();
	}
	private passwords: Promise<PasswordStore> | undefined;
	readonly sudo = new SudoPasswords(() => this.settings.sudoRemember);

	/** Called once a connection is about to start working, before its session exists (src/index.ts takes over pi's tools). */
	onFirstConnect: ((ctx: ExtensionContext) => void) | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.loadSettings();
	}

	get settingsPath(): string {
		return join(this.dir, "settings.json");
	}

	loadSettings(): void {
		try {
			this.settings = existsSync(this.settingsPath) ? normalizeSettings(JSON.parse(readFileSync(this.settingsPath, "utf8"))) : defaultSettings();
		} catch {
			this.settings = defaultSettings();
		}
	}

	/** Saves the settings; returns a problem to show, or undefined. */
	saveSettings(): string | undefined {
		if (this.removed) return undefined;
		try {
			saveJson(this.settingsPath, this.settings);
			return undefined;
		} catch (e) {
			return `couldn't save the settings: ${(e as Error).message}`;
		}
	}

	track(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	/** Hosts named in ~/.ssh/config (patterns left out). */
	sshConfigHosts(): string[] {
		try {
			return sshConfigHosts(readFileSync(join(homedir(), ".ssh", "config"), "utf8"));
		} catch {
			return [];
		}
	}

	/** Shows or hides the model's machine-switching tools, as the setting says. */
	applyModelTools(): void {
		applyModelTools(this.pi, this.settings.modelTools);
	}

	/** Where saved passwords live on this computer (found once). */
	passwordStore(): Promise<PasswordStore> {
		this.passwords ??= passwordStore(this.dir);
		return this.passwords;
	}

	/** How a machine is shown: its saved name, or its address. */
	label(address: string): string {
		return nameFor(this.settings, address) ?? address;
	}

	// ------------------------------------------------------------------ status line

	refreshStatus(ctx: ExtensionContext | undefined = this.ctx): void {
		if (!ctx?.hasUI) return;
		const s = this.session;
		if (!s || !this.settings.statusLine) return ctx.ui.setStatus(STATUS, undefined);
		const where = `${this.label(s.machine)}:${shortPath(s.ws.remoteProject, s.ws.remoteHome)}${s.branch ? ` (${s.branch})` : ""}`;
		const t = ctx.ui.theme;
		if (s.state !== "connected") {
			return ctx.ui.setStatus(STATUS, s.state === "reconnecting" ? t.fg("warning", `ssh ${where} · reconnecting…`) : t.fg("error", `ssh ${where} · connection lost`));
		}
		const parts = [t.fg("accent", `ssh ${where}`)];
		if (s.transfer) parts.push(t.fg("accent", transferBar(s.transfer)));
		if ((s.latency ?? 0) > SLOW_MS) parts.push(t.fg("warning", `slow connection (${s.latency} ms)`));
		ctx.ui.setStatus(STATUS, parts.join(t.fg("dim", " · ")));
	}

	// ------------------------------------------------------------------ connect

	/**
	 * Connects to `address` (or a saved machine's name) and starts working in `project`, or in the folder picked in the
	 * folder browser. Every step and problem goes to `ui`. Returns whether it connected.
	 */
	async connect(ctx: ExtensionContext, address: string, project: string | undefined, ui: ConnectUI): Promise<boolean> {
		this.track(ctx);
		if (this.removed) {
			await ui.failed(`pi-seamless-ssh's files were removed. ${UNINSTALL_HINT}`);
			return false;
		}
		if (this.busy) {
			await ui.failed("pi-seamless-ssh is already connecting.");
			return false;
		}
		const target = parseTarget(addressFor(this.settings, address));
		if ("error" in target) {
			await ui.failed(target.error);
			return false;
		}
		const conflict = this.conflictingTools();
		if (conflict) {
			await ui.failed(conflict);
			return false;
		}
		const other = this.store.read();
		if (other && other.pid !== process.pid && pidAlive(other.pid)) {
			await ui.failed(`pi-seamless-ssh is already connected to ${other.machine} in another pi (process ${other.pid}). Only one pi per computer can be connected.`);
			return false;
		}
		this.busy = true;
		try {
			if (this.session) {
				ui.step(`Disconnecting from ${this.label(this.session.machine)}`);
				await this.disconnect(ctx, { quiet: true });
			}
			return await this.open(ctx, target, project, ui);
		} finally {
			this.busy = false;
		}
	}

	private async open(ctx: ExtensionContext, target: Target, project: string | undefined, ui: ConnectUI): Promise<boolean> {
		const name = this.label(target.label);
		const socketDir = privateSocketDir();
		const id = createHash("sha256").update(`${process.pid}:${target.label}:${Date.now()}`).digest("hex").slice(0, 12);
		const conn = new Connection(target, join(socketDir, `${id}.sock`));
		// Esc while connecting stops this attempt: ssh is ended at once, later steps see `stopped`.
		const attempt = { stopped: false };
		ui.onCancel(() => {
			attempt.stopped = true;
			conn.cancel();
		});
		try {
			return await this.openWith(ctx, target, project, ui, conn, attempt, name, socketDir, id);
		} finally {
			ui.onCancel(() => {});
			// A failed or stopped attempt leaves nothing behind.
			if (!this.session) releaseSocketBase();
		}
	}

	private async openWith(
		ctx: ExtensionContext,
		target: Target,
		project: string | undefined,
		ui: ConnectUI,
		conn: Connection,
		attempt: { stopped: boolean },
		name: string,
		socketDir: string,
		id: string,
	): Promise<boolean> {
		ui.step(`Connecting to ${name}${name !== target.label ? ` (${target.label})` : ""}`);
		const login = await this.makeAskpass(conn, socketDir, id, ui, true);
		try {
			await conn.open(login.askpass);
		} catch (e) {
			if (e instanceof Cancelled || attempt.stopped) {
				ui.cancelled();
				return false;
			}
			await ui.failed(e instanceof SshError ? e.message : `Couldn't connect to ${name}: ${(e as Error).message}`);
			return false;
		} finally {
			login.askpass.stop();
		}
		/** Stops here when the user pressed Esc during a later step. */
		const stoppedNow = async () => {
			if (!attempt.stopped) return false;
			await conn.close();
			ui.cancelled();
			return true;
		};
		await this.keepLogin(conn, target.label, name, login.state, ui);
		if (await stoppedNow()) return false;

		const remote = new Remote(conn);
		const fail = async (message: string) => {
			await conn.close();
			await ui.failed(message);
			return false;
		};
		ui.step(`Checking ${name}`);
		let info;
		let pathProblem: string | undefined;
		try {
			// First the PATH your login gives (so the checks find what your commands will find), then the checks.
			pathProblem = await remote.useLoginPath();
			info = await remote.probe();
		} catch (e) {
			if (await stoppedNow()) return false;
			return fail(`Connected to ${name}, but couldn't run a command there: ${(e as Error).message}`);
		}
		if (await stoppedNow()) return false;
		if (info.missing.length) return fail(`${name} lacks ${info.missing.join(", ")}, which pi-seamless-ssh needs. Nothing was changed.`);

		// A folder given with the command (or remembered): `~` and relative paths start at the remote's home.
		const given = project ? (project.startsWith("/") ? project : project === "~" ? info.home : `${info.home}/${project.replace(/^~\//, "")}`) : undefined;
		const dir = given ?? (await ui.pickFolder(remote, name, this.lastProject(target.label) ?? info.home));
		if (await stoppedNow()) return false;
		if (!dir) {
			await conn.close();
			ui.cancelled();
			return false;
		}
		ui.step(`Opening ${shortPath(dir, info.home)}`);
		if (!(await remote.test("-d -w", dir).catch(() => false))) return fail(`${name}:${dir} isn't a folder you can write to.`);
		const ws: Workspace = { homeAgent: getAgentDir(), homeHome: homedir(), remoteProject: dir, remoteHome: info.home };
		try {
			await remote.mkdirp(remoteAgent(ws));
			await remote.cleanLeftovers(posix.join(dir, ".pi"));
			if (await this.copyInstructions(remote, remoteAgent(ws))) ui.step("Copied this computer's AGENTS.md to the project (its own copy from now on)");
		} catch (e) {
			if (await stoppedNow()) return false;
			return fail(`Couldn't create ${remoteAgent(ws)} on ${name}: ${(e as Error).message}`);
		}
		if (await stoppedNow()) return false;

		// The session's own folders: set-aside home files must be on the same disk as pi's agent folder (they are
		// renamed, never copied); short-lived copies go to RAM when this computer has a RAM file system.
		const sessionDir = join(this.dir, "session", id);
		mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		const scratch = new Scratch(id, join(sessionDir, "scratch"));
		this.store.start({
			version: 1,
			pid: process.pid,
			machine: target.label,
			destination: target.destination,
			...(target.port ? { port: target.port } : {}),
			controlPath: conn.controlPath,
			project: dir,
			remoteHome: info.home,
			sessionId: id,
			...(scratch.ram ? { scratchRam: scratch.ram } : {}),
			placeholders: {},
			setAside: {},
			createdDirs: [],
		});
		this.onFirstConnect?.(ctx);
		this.session = new Session({
			conn,
			remote,
			ws,
			store: this.store,
			sessionDir,
			scratch,
			localPorts: this.settings.localPorts,
			names: detectNameRules(ws.homeAgent),
			hooks: {
				notify: (m, type) => this.ctx?.ui.notify(m, type),
				changed: () => {
					if (this.session && !this.store.record) this.session = undefined;
					this.refreshStatus();
				},
				askReconnect: () => this.askReconnect(),
				askpass: async (person) => (await this.makeAskpass(conn, socketDir, id, dialogUI(this.ctx ?? ctx), person)).askpass,
			},
		});
		ui.step(`Getting the project's files ready`);
		await this.session.sweep();
		// The instructions and the git branch, read now so the status line shows the branch at once.
		await this.session.remoteContext();
		rememberConnection(this.settings, target.label, dir);
		this.saveSettings();
		this.pi.appendEntry<ChatEntry>(ENTRY, { machine: target.label, project: dir });
		this.refreshStatus(ctx);
		ui.done(`Connected to ${name}. The model now works in ${dir}.`);
		if (pathProblem) (this.ctx ?? ctx).ui.notify(`Couldn't read your login PATH on ${name} (${pathProblem}), so commands there only find programs in the standard folders.`, "warning");
		return true;
	}

	/**
	 * The first time a project is used: this computer's global instructions (pi's agent-folder AGENTS.md or CLAUDE.md)
	 * become the project's own copy in <project>/.pi/agent. A project that already has one keeps it, edits included.
	 */
	private async copyInstructions(remote: Remote, remoteAgentDir: string): Promise<boolean> {
		const home = CONTEXT_NAMES.map((n) => join(getAgentDir(), n)).find((p) => existsSync(p) && statSync(p).isFile());
		if (!home) return false;
		const kinds = await remote.kinds(CONTEXT_NAMES.map((n) => posix.join(remoteAgentDir, n)));
		if (kinds.some((k) => k.kind === "file")) return false;
		await remote.writeFile(posix.join(remoteAgentDir, basename(home)), readFileSync(home));
		return true;
	}

	/**
	 * sudo on the remote wants a password: pi's password box, showing the command; Esc refuses. Without pi's terminal UI
	 * it's refused. The box closes by itself when the command ends first.
	 */
	askSudo(request: SudoRequest): Promise<string | undefined> {
		const s = this.session;
		const ctx = this.ctx;
		if (!s || !ctx?.hasUI || ctx.mode !== "tui") return Promise.resolve(undefined);
		return this.sudo.answer(request, s, (r) => {
			const first = r.command.trim().split("\n")[0] ?? "";
			const more = r.command.trim().includes("\n") ? " …" : "";
			const prompt = `A command on ${this.label(s.machine)} runs sudo:\n  ${first.length > 200 ? `${first.slice(0, 200)}…` : first}${more}\n\n${r.prompt.trim() || "Password:"}`;
			return ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
				r.signal.addEventListener("abort", () => done(undefined), { once: true });
				return new PasswordPrompt(
					theme,
					`${this.label(s.machine)} › sudo`,
					prompt,
					{
						offerKeep: false,
						where: "",
						...(r.retry ? { note: "That password didn't work." } : {}),
						hint: `Enter give it to sudo · Esc refuse${this.settings.sudoRemember ? " · kept until you disconnect" : ""}`,
					},
					(a) => done(a.password),
					() => done(undefined),
				);
			});
		});
	}

	/** Removes a saved password (from the keychain and from the list of saved ones). */
	async forgetPassword(account: string): Promise<void> {
		const store = await this.passwordStore();
		await store.remove(account).catch(() => {});
		this.settings.savedPasswords = this.settings.savedPasswords.filter((a) => a !== account);
		this.saveSettings();
	}

	/**
	 * Before uninstalling: disconnects and deletes everything pi-seamless-ssh made on this computer (settings, saved
	 * machines, saved passwords in the keychain, session folders, its helper, sockets, RAM copies, the debug log). The
	 * remote machines are left as they are. Returns the report lines.
	 */
	async removeEverything(ctx: ExtensionContext): Promise<string[]> {
		if (this.removed) return [`pi-seamless-ssh's files were already removed. ${UNINSTALL_HINT}`];
		await this.disconnect(ctx, { quiet: true });
		const lines: string[] = [];
		const store = await this.passwordStore();
		const accounts = [...new Set([...this.settings.savedPasswords, ...this.settings.machines.map((m) => m.address), ...this.settings.recent.map((r) => r.address)])];
		let forgot = 0;
		for (const account of accounts) {
			if ((await store.get(account).catch(() => undefined)) === undefined) continue;
			await store.remove(account).catch(() => {});
			forgot++;
		}
		lines.push(`✓ Removed ${forgot} saved password${forgot === 1 ? "" : "s"} from ${store.where}.`);
		// From here on nothing writes files (settings, sessions, the debug log, sockets).
		markRemoved();
		const places = [this.dir, ...runtimeFolders()];
		const left: string[] = [];
		for (const place of places) {
			try {
				rmSync(place, { recursive: true, force: true });
			} catch {
				left.push(place);
			}
		}
		lines.push(left.length ? `⚠ Couldn't delete: ${left.join(", ")}. Quit pi and delete it by hand.` : `✓ Deleted ${this.dir} (settings, saved machines, session folders, debug log).`);
		try {
			const removed = await cleanNpmCache(packageRoot());
			lines.push(removed > 0 ? `✓ Removed ${removed} cached download${removed === 1 ? "" : "s"} from npm's cache.` : "✓ Nothing of it in npm's cache.");
		} catch (e) {
			lines.push(`⚠ Couldn't clean npm's cache (${(e as Error).message}).`);
		}
		this.settings = defaultSettings();
		this.refreshStatus(ctx);
		lines.push(`Last step: ${UNINSTALL_HINT}`);
		return lines;
	}

	/** The folder last used on that machine, if any. */
	lastProject(address: string): string | undefined {
		return this.settings.recent.find((r) => r.address === address)?.project;
	}

	/**
	 * ssh's questions through the connect UI. A new host key is shown for trusting. For a password, the saved one is
	 * tried first; then (only when `person` is true) the user is asked, and Esc there stops the whole connection rather
	 * than one try. What the user typed and chose to keep is left in `state` for {@link keepLogin}.
	 */
	private async makeAskpass(conn: Connection, socketDir: string, id: string, ui: ConnectUI, person: boolean): Promise<{ askpass: Askpass; state: LoginState }> {
		const name = this.label(conn.machine);
		const store = await this.passwordStore();
		const saved = await store.get(conn.machine).catch(() => undefined);
		const state: LoginState = { savedFailed: false };
		let savedTried = false;
		const askpass = new Askpass(join(this.dir, "bin"), socketDir, id, async (prompt) => {
			if (isHostKeyQuestion(prompt)) {
				if (!person) return "no";
				return (await ui.trustHost(name, prompt)) ? "yes" : "no";
			}
			conn.usedPrompt = true;
			if (saved !== undefined && !savedTried) {
				savedTried = true;
				state.usedSaved = true;
				ui.step("Using the saved password");
				return saved;
			}
			if (savedTried) state.savedFailed = true;
			if (!person) {
				conn.cancel();
				return undefined;
			}
			const machine = this.settings.machines.find((m) => m.address === conn.machine);
			const answer = await ui.password(name, prompt, {
				offerKeep: true,
				...(machine?.keep ? { preset: machine.keep } : {}),
				where: `in ${store.where}`,
				...(state.savedFailed ? { note: "The saved password didn't work." } : {}),
			});
			if (!answer) {
				conn.cancel();
				return undefined;
			}
			state.typed = answer.password;
			state.keep = answer.keep;
			return answer.password;
		});
		await askpass.start();
		return { askpass, state };
	}

	/**
	 * After a password login: save the password, or set up key login, as ticked. A saved password that no longer
	 * worked is removed unless the new one is saved instead. Problems here don't undo the connection.
	 */
	private async keepLogin(conn: Connection, account: string, name: string, state: LoginState, ui: ConnectUI): Promise<void> {
		const store = await this.passwordStore();
		if (state.keep === "password" && state.typed !== undefined) {
			try {
				await store.set(account, state.typed);
				if (!this.settings.savedPasswords.includes(account)) this.settings.savedPasswords.push(account);
				this.saveSettings();
				ui.step(`Saved the password in ${store.where}`);
			} catch (e) {
				ui.step(`Couldn't save the password: ${(e as Error).message}`);
			}
		} else if (state.savedFailed) await this.forgetPassword(account);
		if (state.keep === "key") {
			try {
				const { key, made } = localPublicKey();
				await installKey(new Remote(conn), key);
				ui.step(`Set up key login on ${name}${made ? " (made a key for this computer: ~/.ssh/id_ed25519)" : ""}`);
			} catch (e) {
				ui.step(`Couldn't set up key login: ${(e as Error).message}`);
			}
		}
		state.typed = undefined;
	}

	private async askReconnect(): Promise<"retry" | "wait" | "home"> {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return "wait";
		const s = this.session;
		const choice = await ctx.ui.select(`The connection to ${s ? this.label(s.machine) : "the remote"} is lost`, ["Try again", "Keep waiting (tries again in 30 s)", "Go back to this computer"]);
		if (choice === "Try again") return "retry";
		if (choice === "Go back to this computer") return "home";
		return "wait";
	}

	// ------------------------------------------------------------------ disconnect

	async disconnect(ctx: ExtensionContext | undefined, options: { quiet?: boolean; remember?: boolean } = {}): Promise<void> {
		const s = this.session;
		if (!s) return;
		this.session = undefined;
		await s.close();
		releaseSocketBase();
		if (options.remember !== false) this.pi.appendEntry<ChatEntry>(ENTRY, { machine: null });
		this.refreshStatus(ctx);
		if (!options.quiet) ctx?.ui.notify(`Disconnected from ${this.label(s.machine)}. The model works on this computer again.`, "info");
	}

	// ------------------------------------------------------------------ startup

	/** A record left by a pi that stopped while connected: put home back as it was. */
	async cleanupLeftover(ctx: ExtensionContext): Promise<void> {
		const rec = this.store.read();
		if (!rec || (rec.pid !== process.pid && pidAlive(rec.pid))) return;
		const kept: string[] = [];
		const left = undoHomeChanges(rec, getAgentDir(), (rel) => kept.push(rel));
		await closeLeftover(rec.controlPath, rec.destination, rec.port);
		const sessionDir = join(this.dir, "session", rec.sessionId);
		if (rec.scratchRam) rmSync(rec.scratchRam, { recursive: true, force: true });
		rmSync(join(sessionDir, "scratch"), { recursive: true, force: true });
		if (left.length === 0) rmSync(sessionDir, { recursive: true, force: true });
		this.store.clear();
		const notes = [
			kept.length ? `kept ${kept.join(", ")} (an extension wrote to them)` : "",
			left.length ? `couldn't put back ${left.join(", ")} (they're in ${join(sessionDir, "set-aside")})` : "",
		].filter(Boolean);
		ctx.ui.notify(`pi-seamless-ssh tidied up after an earlier pi that stopped while connected to ${this.label(rec.machine)}${notes.length ? `: ${notes.join("; ")}` : ""}.`, notes.length ? "warning" : "info");
	}

	/** The machine this chat was last on, from its entries. */
	chatMachine(ctx: ExtensionContext): ChatEntry | undefined {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; customType?: string; data?: ChatEntry };
			if (e.type === "custom" && e.customType === ENTRY && e.data) return e.data;
		}
		return undefined;
	}

	/**
	 * Where this point of the chat was working, compared with now: when a chat is opened again (resume, fork, reload) or
	 * you move to another point with /tree, the chat follows that point's machine, as the "reopening" setting says:
	 * reconnect automatically (a reload always does: it's the same chat continuing), ask first, or leave it as it is.
	 */
	async followChat(ctx: ExtensionContext, reason: string): Promise<{ connect: { address: string; project: string } } | { disconnect: true } | undefined> {
		const there = this.chatMachine(ctx);
		const target = there?.machine && there.project ? { address: there.machine, project: there.project } : undefined;
		const now = this.session;
		if (target && now && now.machine === target.address && now.ws.remoteProject === target.project) return undefined;
		if (!target && !now) return undefined;
		const mode = reason === "reload" ? "reconnect" : this.settings.reopen;
		if (mode === "home") return undefined;
		if (mode === "ask") {
			if (!ctx.hasUI) return undefined;
			const question = target
				? `This point of the chat was working on ${this.label(target.address)} in ${target.project}. Go there?`
				: `This point of the chat was working on this computer. Disconnect from ${this.label(now!.machine)}?`;
			if (!(await ctx.ui.confirm(target ? "Reconnect?" : "Disconnect?", question))) return undefined;
		}
		return target ? { connect: target } : { disconnect: true };
	}

	/** Another extension also replacing read/write/edit/bash/…: routing would only half work, so it's refused. */
	conflictingTools(): string | undefined {
		const ours = dirname(dirname(fileURLToPath(import.meta.url)));
		const tools = this.pi.getAllTools();
		const others = ROUTED.filter((name) => {
			const tool = tools.find((t) => t.name === name);
			const path = tool?.sourceInfo?.path ?? "";
			return tool && !path.startsWith("builtin:") && !path.startsWith(ours);
		});
		return others.length ? `Another extension also replaces ${others.join(", ")}. pi-seamless-ssh won't connect, because those tools would still run on this computer. Remove one of the two extensions.` : undefined;
	}
}

/** "↑ ▕██████░░░░▏ 61% 12.3/20.1 MB" */
export function transferBar(t: Transfer): string {
	const share = t.total > 0 ? Math.min(1, t.done / t.total) : 0;
	const cells = 10;
	const full = Math.round(share * cells);
	const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
	return `${t.direction === "up" ? "↑" : "↓"} ▕${"█".repeat(full)}${"░".repeat(cells - full)}▏ ${Math.round(share * 100)}% ${mb(t.done)}/${mb(t.total)} MB`;
}

/** A private folder for the connection's sockets: short (socket paths are limited to about 100 characters) and mode 700. */
function privateSocketDir(): string {
	const dir = socketBase();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}
