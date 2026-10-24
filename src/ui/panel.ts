// The /ssh panel. Everything happens inside its frame, and Esc always goes back one step:
//
//   ssh
//     [CONNECTED]            Disconnect from vm                ~/project
//     [PORT FORWARDS]        localhost:3000 → vm:3000          → Enter closes it
//     [RECENT CONNECTIONS]   vm                                ~/project        → straight back into that folder
//     [MACHINES]             vm                                me@192.168.1.20  → the machine's page
//                            lxc                               ~/.ssh/config
//                            + Save a machine
//                            Connect to an address…
//     [SETTINGS]             Reopening a chat that was connected   ask me
//                            Status line                           on
//                            The model can switch machines         off
//                            Remember the sudo password            off · every sudo asks
//                            Ports kept local                      none
//     [DANGER]               Remove everything…
//
// Connecting shows its steps in the frame (and the password, a new host key, the folder browser), then closes the
// panel. A problem is shown in the frame; Esc goes back to the menu.

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { shortPath } from "../core/browser.ts";
import { KEEP_TEXT, type Keep, machineNameProblem, parsePorts, REOPEN_MODES, REOPEN_TEXT, type SavedMachine } from "../core/settings.ts";
import { parseTarget } from "../core/target.ts";
import { type Controller, removalDetails } from "../controller.ts";
import { FolderBrowser } from "./browser.ts";
import { InputStep, ListMenu, type MenuItem, MenuStack } from "./components.ts";
import { PasswordPrompt } from "./password.ts";
import type { ConnectUI } from "./connect-ui.ts";
import { confirmMenu, ProgressView } from "./progress.ts";

export interface PanelStart {
	/** Connect right away (from `/ssh <machine> [folder]`, or reopening a chat); Esc afterwards shows the menu. */
	connect?: { address: string; project?: string };
}

export function showPanel(ctx: ExtensionContext, c: Controller, start: PanelStart = {}): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			done(undefined);
		};
		const render = () => tui.requestRender();
		const refreshers = new Map<Component, () => void>();
		const stack = new MenuStack(close, () => refreshers.get(stack.top()!)?.());
		const open = (component: Component, refresh?: () => void) => {
			if (refresh) refreshers.set(component, refresh);
			stack.push(component);
			render();
		};
		/** Removes `component` from the top of the stack if it's there (a flow step finishing). */
		const drop = (component: Component) => {
			if (stack.top() === component) stack.pop();
			render();
		};
		const tall = () => Math.max(10, (tui.terminal?.rows ?? 40) - 14);
		const say = (menu: ListMenu, problem: string | undefined, itemId?: string) => problem && menu.setStatus(problem, "error", itemId);

		// ------------------------------------------------------------------ connecting

		const connect = (address: string, project?: string) => {
			const progress = new ProgressView(theme, `ssh › ${c.label(address)}`, () => drop(progress));
			open(progress);
			const ui = panelUI(tui, theme, progress, open, drop, render, (message) => {
				close();
				ctx.ui.notify(message, "info");
			});
			void c.connect(ctx, address, project, ui);
		};

		// ------------------------------------------------------------------ menus

		const mainItems = (): MenuItem[] => {
			const items: MenuItem[] = [];
			const s = c.session;
			if (s) {
				items.push({ id: "h-c", label: "[CONNECTED]", heading: true, disabled: true });
				items.push({
					id: "off",
					label: `Disconnect from ${c.label(s.machine)}`,
					detail: shortPath(s.ws.remoteProject, s.ws.remoteHome),
					description: "Back to this computer. The project keeps its files on the remote; this computer's own files come back as they were.",
				});
				const forwards = s.forwardsList();
				if (forwards.length) {
					items.push({ id: "g0", label: "", disabled: true });
					items.push({ id: "h-f", label: "[PORT FORWARDS]", heading: true, disabled: true });
					for (const f of forwards) {
						items.push({
							id: `f:${f.remote}`,
							label: `localhost:${f.local} → ${c.label(s.machine)}:${f.remote}`,
							description: `Tools on this computer reach ${c.label(s.machine)}'s port ${f.remote} at localhost:${f.local}. Enter closes it (it opens again if a tool uses that port).`,
						});
					}
				}
				items.push({ id: "g1", label: "", disabled: true });
			}
			if (c.settings.recent.length) {
				items.push({ id: "h-r", label: "[RECENT CONNECTIONS]", heading: true, disabled: true });
				c.settings.recent.forEach((r, i) => {
					items.push({ id: `r:${i}`, label: c.label(r.address), detail: r.project, description: `Connect to ${c.label(r.address)} and work in ${r.project} again.` });
				});
				items.push({ id: "g2", label: "", disabled: true });
			}
			items.push({ id: "h-m", label: "[MACHINES]", heading: true, disabled: true });
			for (const m of c.settings.machines) items.push({ id: `m:${m.name}`, label: m.name, detail: m.address, description: `Connect to ${m.name}, rename it, change its address or delete it.` });
			for (const h of c.sshConfigHosts().filter((h) => !c.settings.machines.some((m) => m.address === h || m.name === h))) {
				items.push({ id: `h:${h}`, label: h, detail: "~/.ssh/config", description: `${h} from your ~/.ssh/config: connect to it, or save it under a name.` });
			}
			items.push({ id: "add", label: "+ Save a machine", description: "Give a machine a name and an address (user@address or user@address:port); then /ssh <name> connects to it." });
			items.push({ id: "type", label: "Connect to an address…", description: "Connect once to user@address or user@address:port, without saving it." });
			items.push({ id: "g3", label: "", disabled: true });
			items.push({ id: "h-s", label: "[SETTINGS]", heading: true, disabled: true });
			items.push({
				id: "reopen",
				label: "Reopening a chat that was connected",
				detail: REOPEN_TEXT[c.settings.reopen],
				description: "When you resume or fork a chat, or move to another point of it with /tree, and that point was working somewhere else: switch automatically, ask you first, or leave the connection as it is.",
			});
			items.push({ id: "status", label: "Status line", detail: c.settings.statusLine ? "on" : "off", description: "The machine and project folder at the bottom of pi while connected." });
			items.push({
				id: "model",
				label: "The model can switch machines",
				detail: c.settings.modelTools ? "on" : "off",
				description: "Lets the model connect to your saved machines and disconnect by itself, when you ask it to (e.g. \"check the logs on lxc\"). Only machines that log in without a password prompt (key login, or a saved password).",
			});
			items.push({
				id: "sudo",
				label: "Remember the sudo password",
				detail: c.settings.sudoRemember ? "on · until you disconnect" : "off · every sudo asks",
				description: "Off: every sudo the model (or a !command) runs on the remote asks you, showing the command; Esc refuses. On: the first password you give is kept in memory (never saved) and given to every sudo after it until you disconnect, so the model can use sudo without asking.",
			});
			items.push({
				id: "ports",
				label: "Ports kept local",
				detail: c.settings.localPorts.length ? c.settings.localPorts.join(", ") : "none",
				description: "While connected, a tool on this computer that opens localhost:<port> reaches the remote's port. Ports listed here keep pointing at this computer.",
			});
			items.push({ id: "g4", label: "", disabled: true });
			items.push({ id: "h-d", label: "[DANGER]", heading: true, disabled: true, detail: "Can't be undone." });
			items.push({
				id: "remove",
				label: "Remove everything…",
				description: "Before uninstalling: deletes everything pi-seamless-ssh made on this computer: settings, saved machines, saved passwords, session folders, debug log. Asks first.",
			});
			return items;
		};

		const main: ListMenu = new ListMenu(theme, {
			title: "ssh",
			items: mainItems(),
			maxVisible: tall,
			onCancel: () => stack.pop(),
			onSelect: (item) => {
				const id = item.id;
				if (id === "off") {
					void c.disconnect(ctx).then(() => {
						main.setItems(mainItems());
						render();
					});
					return;
				}
				if (id.startsWith("r:")) {
					const r = c.settings.recent[Number(id.slice(2))];
					if (r) connect(r.address, r.project);
					return;
				}
				if (id.startsWith("m:")) return machinePage(id.slice(2));
				if (id.startsWith("h:")) return configHostPage(id.slice(2));
				if (id === "add") return saveMachine();
				if (id === "type") {
					return open(
						new InputStep(theme, "ssh › Connect to an address", "user@address or user@address:port (a name from ~/.ssh/config works too).", "", (value) => {
							const address = value.trim();
							const problem = addressProblem(address);
							if (problem) return problem;
							stack.pop();
							connect(address);
							return undefined;
						}, () => stack.pop()),
					);
				}
				if (id === "reopen") return reopenMenu();
				if (id === "status") {
					c.settings.statusLine = !c.settings.statusLine;
					say(main, c.saveSettings(), id);
					c.refreshStatus(ctx);
					main.setItems(mainItems(), id);
					return render();
				}
				if (id.startsWith("f:")) {
					const s = c.session;
					if (!s) return;
					void s.closeForward(Number(id.slice(2))).then(() => {
						main.setItems(mainItems());
						main.setStatus("closed", "ok");
						render();
					});
					return;
				}
				if (id === "remove") {
					return open(
						confirmMenu(theme, "ssh › Remove everything", removalDetails(c.dir), "Remove everything", "Keep it", (ok) => {
							stack.pop();
							if (!ok) return;
							void c.removeEverything(ctx).then((lines) => {
								close();
								ctx.ui.notify(`pi-seamless-ssh removed.\n${lines.join("\n")}`, lines.some((l) => l.startsWith("⚠")) ? "warning" : "info");
							});
						}),
					);
				}
				if (id === "sudo") {
					c.settings.sudoRemember = !c.settings.sudoRemember;
					if (!c.settings.sudoRemember) c.sudo.forget();
					say(main, c.saveSettings(), id);
					main.setItems(mainItems(), id);
					return render();
				}
				if (id === "model") {
					c.settings.modelTools = !c.settings.modelTools;
					say(main, c.saveSettings(), id);
					c.applyModelTools();
					main.setItems(mainItems(), id);
					return render();
				}
				if (id === "ports") {
					return open(
						new InputStep(theme, "ssh › Ports kept local", "Port numbers separated by commas, e.g. 3000, 8080. Empty: every localhost port goes to the remote while connected. Applies from the next connection.", c.settings.localPorts.join(", "), (value) => {
							const ports = value.trim() ? parsePorts(value) : [];
							if (typeof ports === "string") return ports;
							c.settings.localPorts = ports;
							const problem = c.saveSettings();
							if (problem) return problem;
							stack.pop();
							return undefined;
						}, () => stack.pop()),
					);
				}
				return undefined;
			},
		});

		const reopenMenu = () => {
			const menu: ListMenu = new ListMenu(theme, {
				title: "ssh › Reopening a chat that was connected",
				description: "When you resume or fork a chat, or move in it with /tree, and that point was working somewhere else:",
				items: REOPEN_MODES.map((mode) => ({
					id: mode,
					label: REOPEN_TEXT[mode],
					marker: c.settings.reopen === mode ? "●" : "○",
					description:
						mode === "ask" ? "pi asks whether to switch to where that point was working." : mode === "reconnect" ? "It switches by itself: connects, or disconnects when that point was on this computer." : "The connection stays as it is; /ssh switches when you want.",
				})),
				initialId: c.settings.reopen,
				onCancel: () => stack.pop(),
				onSelect: (item) => {
					c.settings.reopen = item.id as (typeof REOPEN_MODES)[number];
					const problem = c.saveSettings();
					if (problem) return void menu.setStatus(problem, "error", item.id);
					stack.pop();
				},
			});
			open(menu);
		};

		/** What happens when a machine asks for a password, as a choice menu; `chosen` gets the answer. */
		const keepMenu = (title: string, current: Keep | undefined, chosen: (keep: Keep | undefined) => void) => {
			const options: (Keep | "ask")[] = ["ask", "password", "key"];
			open(
				new ListMenu(theme, {
					title,
					description: "When this machine asks for a password (the password screen starts with this ticked):",
					items: options.map((o) => ({
						id: o,
						label: KEEP_TEXT[o],
						marker: (current ?? "ask") === o ? "●" : "○",
						description:
							o === "ask"
								? "Type it each time."
								: o === "password"
									? "Typed once, then saved in this computer's keychain and used by itself (also when reconnecting)."
									: "Typed once; then this computer's key is added to the machine, and it logs in without a password.",
					})),
					initialId: current ?? "ask",
					onCancel: () => stack.pop(),
					onSelect: (item) => chosen(item.id === "ask" ? undefined : (item.id as Keep)),
				}),
			);
		};

		/** A new machine: a name, an address, then what to do with its password. `presetAddress` skips the address. */
		const saveMachine = (presetAddress?: string) => {
			const finish = (name: string, address: string, levels: number) =>
				keepMenu(`ssh › ${name} › Password`, undefined, (keep) => {
					c.settings.machines.push({ name, address, ...(keep ? { keep } : {}) });
					const problem = c.saveSettings();
					stack.popTo(levels);
					if (problem) main.setStatus(problem, "error");
				});
			const askAddress = (name: string) =>
				open(
					new InputStep(theme, `ssh › ${name} › Address`, "user@address or user@address:port (a name from ~/.ssh/config works too).", "", (value) => {
						const address = value.trim();
						const problem = addressProblem(address);
						if (problem) return problem;
						finish(name, address, 3);
						return undefined;
					}, () => stack.pop()),
				);
			open(
				new InputStep(theme, "ssh › Save a machine", "A short name, one word: you'll type it after /ssh.", "", (value) => {
					const name = value.trim();
					const problem = machineNameProblem(c.settings, name);
					if (problem) return problem;
					if (presetAddress) finish(name, presetAddress, 3);
					else askAddress(name);
					return undefined;
				}, () => stack.pop()),
			);
		};

		/** Changes one field of a saved machine. */
		const editMachine = (m: SavedMachine, field: "name" | "address") => {
			open(
				new InputStep(
					theme,
					`ssh › ${m.name} › ${field === "name" ? "Name" : "Address"}`,
					field === "name" ? "A short name, one word: you'll type it after /ssh." : "user@address or user@address:port (a name from ~/.ssh/config works too).",
					field === "name" ? m.name : m.address,
					(value) => {
						const v = value.trim();
						const problem = field === "name" ? machineNameProblem(c.settings, v, m.name) : addressProblem(v);
						if (problem) return problem;
						if (field === "name") m.name = v;
						else m.address = v;
						const saveProblem = c.saveSettings();
						if (saveProblem) return saveProblem;
						stack.pop();
						return undefined;
					},
					() => stack.pop(),
				),
			);
		};

		const machinePage = (name: string) => {
			const current = c.settings.machines.find((m) => m.name === name);
			if (!current) return;
			// The same saved entry even after a rename; gone once deleted.
			const machine = () => c.settings.machines.find((m) => m === current);
			const items = (): MenuItem[] => {
				const m = machine()!;
				return [
					{ id: "connect", label: "Connect", description: `Connect to ${m.name}, then pick the project folder.` },
					{ id: "name", label: "Name", detail: m.name, description: "What you type after /ssh." },
					{ id: "address", label: "Address", detail: m.address, description: "user@address or user@address:port." },
					{ id: "keep", label: "Password", detail: KEEP_TEXT[m.keep ?? "ask"], description: "What happens when it asks for a password: ask each time, save it, or set up key login." },
					{ id: "forget", label: "Forget its saved password", description: "Removes a password saved for this machine (it asks again next time)." },
					{ id: "delete", label: "Delete", description: "Forgets this machine and its saved password (its recent connections stay in the list)." },
				];
			};
			const page: ListMenu = new ListMenu(theme, {
				title: `ssh › ${current.name}`,
				items: items(),
				onCancel: () => stack.pop(),
				onSelect: (item) => {
					const m = machine();
					if (!m) return;
					if (item.id === "connect") {
						stack.pop();
						return connect(m.address);
					}
					if (item.id === "name" || item.id === "address") return editMachine(m, item.id);
					if (item.id === "keep") {
						return keepMenu(`ssh › ${m.name} › Password`, m.keep, (keep) => {
							if (keep) m.keep = keep;
							else delete m.keep;
							const problem = c.saveSettings();
							stack.pop();
							if (problem) page.setStatus(problem, "error", "keep");
						});
					}
					if (item.id === "forget") {
						void c.forgetPassword(m.address).then(() => {
							page.setStatus("forgotten", "ok", "forget");
							render();
						});
						return;
					}
					if (item.id === "delete") {
						return open(
							confirmMenu(theme, `ssh › ${m.name} › Delete`, `Delete ${m.name} (${m.address})?`, "Delete it", "Keep it", (ok) => {
								stack.pop();
								if (!ok) return;
								c.settings.machines = c.settings.machines.filter((x) => x !== m);
								void c.forgetPassword(m.address);
								say(main, c.saveSettings());
								stack.pop();
							}),
						);
					}
					return undefined;
				},
			});
			open(page, () => {
				if (machine()) page.setItems(items());
			});
		};

		const configHostPage = (host: string) => {
			open(
				new ListMenu(theme, {
					title: `ssh › ${host}`,
					description: `${host} is defined in your ~/.ssh/config.`,
					items: [
						{ id: "connect", label: "Connect", description: `Connect to ${host}, then pick the project folder.` },
						{ id: "save", label: "Save under a name…", description: "Keep it in the machines list under a name of your own." },
					],
					onCancel: () => stack.pop(),
					onSelect: (item) => {
						if (item.id === "connect") {
							stack.pop();
							return connect(host);
						}
						return saveMachine(host);
					},
				}),
			);
		};

		open(main, () => main.setItems(mainItems()));
		if (start.connect) connect(start.connect.address, start.connect.project);
		return stack;
	});
}

/** Connecting inside the panel: steps in the progress view, questions and the folder browser on top of it. */
function panelUI(
	tui: TUI,
	theme: Theme,
	progress: ProgressView,
	open: (component: Component) => void,
	drop: (component: Component) => void,
	render: () => void,
	finish: (message: string) => void,
): ConnectUI {
	return {
		step: (text) => {
			progress.step(text);
			render();
		},
		password: (machine, prompt, options) =>
			new Promise((resolve) => {
				const step = new PasswordPrompt(theme, machine, prompt, options, (answer) => {
					drop(step);
					resolve(answer);
				}, () => {
					drop(step);
					resolve(undefined);
				});
				open(step);
			}),
		trustHost: (machine, prompt) =>
			new Promise((resolve) => {
				const menu = confirmMenu(theme, `ssh › ${machine} › New machine`, `${prompt.trim()}\n\nThis is the first connection to this machine. Accept its key only if the fingerprint is the machine's.`, "Trust it and connect", "Don't connect", (ok) => {
					drop(menu);
					resolve(ok);
				});
				open(menu);
			}),
		pickFolder: (remote, machine, start) =>
			new Promise((resolve) => {
				const browser: FolderBrowser = new FolderBrowser(
					theme,
					{ tree: (dir) => remote.dirsTree(dir), mkdir: async (dir) => void (await remote.mkdirp(dir)), home: remote.info.home, machine },
					start,
					() => tui.requestRender(),
					(dir) => {
						drop(browser);
						resolve(dir);
					},
					() => {
						drop(browser);
						resolve(undefined);
					},
					() => Math.max(8, (tui.terminal?.rows ?? 40) - 16),
				);
				open(browser);
			}),
		failed: async (message) => {
			progress.fail(message);
			render();
		},
		done: finish,
		cancelled: () => drop(progress),
		onCancel: (stop) => {
			progress.stop = stop;
		},
	};
}

/** A problem with an address typed for ssh, or undefined. */
function addressProblem(address: string): string | undefined {
	const parsed = parseTarget(address);
	return "error" in parsed ? parsed.error : undefined;
}
