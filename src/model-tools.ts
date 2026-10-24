// Tools for the model to switch machines by itself, when "The model can switch machines" is on (off by default):
//   ssh_machines     the saved machines, their last folders, and where the chat works now
//   ssh_connect      connect to a saved machine (and folder) and work there
//   ssh_disconnect   back to this computer
// Only saved machines, and nobody is asked anything: a machine that needs a password without a saved one, or that
// was never trusted, is refused with a message saying what the user can do in /ssh.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Controller } from "./controller.ts";
import type { ConnectUI } from "./ui/connect-ui.ts";

export const MODEL_TOOLS = ["ssh_machines", "ssh_connect", "ssh_disconnect"] as const;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** Connecting with no person: questions are refused, the outcome is collected. */
function modelUI(): ConnectUI & { outcome(): string } {
	let result = "";
	const reasons: string[] = [];
	return {
		step: () => {},
		password: async () => {
			reasons.push("it asks for a password and none is saved (the user can save one, or set up key login, in /ssh)");
			return undefined;
		},
		trustHost: async () => {
			reasons.push("its host key isn't trusted yet (the user has to connect once with /ssh)");
			return false;
		},
		pickFolder: async () => undefined,
		failed: async (message) => void (result = message),
		done: (message) => void (result = message),
		cancelled: () => void (result = reasons.length ? `Not connected: ${reasons.join("; ")}.` : "Not connected: no folder was given and none was used there before."),
		onCancel: () => {},
		outcome: () => result || (reasons.length ? `Not connected: ${reasons.join("; ")}.` : "Not connected."),
	};
}

export function registerModelTools(pi: ExtensionAPI, c: Controller): void {
	pi.registerTool({
		name: "ssh_machines",
		label: "SSH: machines",
		description: "List the machines you can work on with ssh_connect, the folders used on them before, and where you work now.",
		parameters: Type.Object({}),
		async execute() {
			const now = c.session ? `Now working on ${c.label(c.session.machine)} in ${c.session.ws.remoteProject}.` : "Now working on this computer.";
			const machines = c.settings.machines.map((m) => {
				const folders = c.settings.recent.filter((r) => r.address === m.address).map((r) => r.project);
				return `- ${m.name}${folders.length ? `: ${folders.join(", ")}` : ""}`;
			});
			return text([now, "", machines.length ? "Saved machines (name: folders used before):" : "No machines are saved (the user saves them in /ssh).", ...machines].join("\n"));
		},
	});

	pi.registerTool({
		name: "ssh_connect",
		label: "SSH: connect",
		description:
			"Work on another machine: after this, read, write, edit, bash, grep, find and ls run on that machine, in the folder given. Only when the user asks for it. Use ssh_machines for the names.",
		parameters: Type.Object({
			machine: Type.String({ description: "A saved machine's name (see ssh_machines)" }),
			folder: Type.Optional(Type.String({ description: "The project folder there (absolute, or ~/…). Default: the one used there last." })),
		}),
		async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
			const machine = c.settings.machines.find((m) => m.name === params.machine);
			if (!machine) return text(`"${params.machine}" isn't a saved machine. Saved: ${c.settings.machines.map((m) => m.name).join(", ") || "none"}.`);
			const folder = params.folder?.trim() || c.lastProject(machine.address);
			if (!folder) return text(`Give a folder: nothing was used on ${machine.name} before.`);
			const ui = modelUI();
			const ok = await c.connect(ctx, machine.address, folder, ui);
			if (!ok || !c.session) return text(ui.outcome());
			return text(`Connected to ${machine.name}. Your tools now work there, in ${c.session.ws.remoteProject}; paths are that machine's.`);
		},
	});

	pi.registerTool({
		name: "ssh_disconnect",
		label: "SSH: disconnect",
		description: "Stop working on the other machine: your tools work on this computer again.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx: ExtensionContext) {
			if (!c.session) return text("Already working on this computer.");
			const name = c.label(c.session.machine);
			await c.disconnect(ctx, { quiet: true });
			return text(`Disconnected from ${name}. Your tools work on this computer again.`);
		},
	});
}

/** Shows the tools to the model, or hides them, as the setting says. */
export function applyModelTools(pi: ExtensionAPI, on: boolean): void {
	const active = pi.getActiveTools().filter((t) => !(MODEL_TOOLS as readonly string[]).includes(t));
	pi.setActiveTools(on ? [...active, ...MODEL_TOOLS] : active);
}
