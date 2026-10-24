// pi-seamless-ssh: point a chat at another machine over SSH. The model works there as if it lived there (pi's file
// and shell tools run on the remote), every extension keeps working on this machine, and the project keeps its own
// pi files in <project>/.pi/agent, shown on this machine as placeholders. See README.md.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Controller } from "./controller.ts";
import { dialogUI } from "./ui/connect-ui.ts";
import { showPanel } from "./ui/panel.ts";
import { registerHooks } from "./hooks/hooks.ts";
import { registerRouted } from "./routed/tools.ts";
import { registerCommand } from "./ui/command.ts";
import { applyModelTools, registerModelTools } from "./model-tools.ts";
import { remoteAtProvider } from "./ui/at-complete.ts";

export default function (pi: ExtensionAPI) {
	const c = new Controller(pi);
	const session = () => c.session;

	registerRouted(pi, session, (request) => c.askSudo(request));
	registerHooks(pi, session);
	registerCommand(pi, c);
	registerModelTools(pi, c);
	let completionAdded = false;

	pi.on("session_start", async (event, ctx) => {
		c.track(ctx);
		c.loadSettings();
		// First undo anything a pi that stopped while connected left behind.
		await c.cleanupLeftover(ctx);
		c.refreshStatus(ctx);
		applyModelTools(pi, c.settings.modelTools);
		// `@` suggestions come from the remote project while connected (pi's own otherwise).
		if (ctx.hasUI && ctx.mode === "tui" && !completionAdded) {
			completionAdded = true;
			ctx.ui.addAutocompleteProvider((current) => remoteAtProvider(current, session));
		}
		await follow(ctx, event.reason);
	});

	// Moving to another point of the chat with /tree: the chat follows that point's machine too.
	pi.on("session_tree", async (_event, ctx) => {
		c.track(ctx);
		await follow(ctx, "tree");
	});

	/** Connects or disconnects so the chat works where this point of it was working (see Controller.followChat). */
	async function follow(ctx: ExtensionContext, reason: string): Promise<void> {
		const step = await c.followChat(ctx, reason);
		if (!step) return;
		// Moving in the tree changes nothing in the chat itself: no "disconnected" entry is added.
		if ("disconnect" in step) return void (await c.disconnect(ctx, { remember: false }));
		if (ctx.hasUI && ctx.mode === "tui") void showPanel(ctx, c, { connect: step.connect });
		else await c.connect(ctx, step.connect.address, step.connect.project, dialogUI(ctx));
	}

	pi.on("session_shutdown", async (_event, ctx) => {
		c.track(ctx);
		// The chat keeps its machine in its entries, so a resume or reload can return to it.
		await c.disconnect(ctx, { quiet: true, remember: false });
	});
}
