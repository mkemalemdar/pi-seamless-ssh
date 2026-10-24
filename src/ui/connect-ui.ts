// What connecting needs from the screen: show each step, ask for a password, ask to trust a new host key, let the user
// pick the project folder, show a problem, say it's done. The /ssh panel does all of it inside its frame; without
// pi's terminal UI (RPC, scripts) plain dialogs and notices stand in.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Remote } from "../ssh/remote.ts";
import { type PasswordAnswer, type PasswordOptions, PasswordPrompt } from "./password.ts";

export interface ConnectUI {
	step(text: string): void;
	/** A password or passphrase, and what to keep of it; undefined when cancelled (the connection is then stopped). */
	password(machine: string, prompt: string, options: PasswordOptions): Promise<PasswordAnswer | undefined>;
	trustHost(machine: string, prompt: string): Promise<boolean>;
	/** The project folder; undefined when the user went back. */
	pickFolder(remote: Remote, machine: string, start: string): Promise<string | undefined>;
	/** A problem; the user goes back from it. */
	failed(message: string): Promise<void>;
	/** Connected. */
	done(message: string): void;
	/** The user stopped it (Esc while connecting, or going back): nothing more to show. */
	cancelled(): void;
	/** Called when the user asks to stop (Esc while a step is running). */
	onCancel(stop: () => void): void;
}

/** Without the panel: notices, pi's own dialogs, and no folder browser (the folder must be given). */
export function dialogUI(ctx: ExtensionContext): ConnectUI {
	return {
		step: () => {},
		password: (machine, prompt, options) =>
			ctx.hasUI && ctx.mode === "tui"
				? ctx.ui.custom<PasswordAnswer | undefined>((_tui, theme, _kb, done) => new PasswordPrompt(theme, machine, prompt, options, (a) => done(a), () => done(undefined)))
				: Promise.resolve(undefined),
		trustHost: (machine, prompt) => ctx.ui.confirm(`Trust ${machine}?`, `${prompt.trim()}\n\nAccept the key only if the fingerprint is the machine's.`),
		pickFolder: async () => {
			ctx.ui.notify("Give the project folder too: /ssh <machine> <folder>", "warning");
			return undefined;
		},
		failed: async (message) => ctx.ui.notify(message, "error"),
		done: (message) => ctx.ui.notify(message, "info"),
		cancelled: () => {},
		onCancel: () => {},
	};
}
