// Test helper: /pss-tree <entry id> moves the chat to that point, as /tree does (pi's navigateTree).
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// PSS_PROBE_PROMPT=<file>: each run's system prompt (after the other extensions changed it) is appended there.
	const probe = process.env.PSS_PROBE_PROMPT;
	if (probe) pi.on("before_agent_start", (event) => void appendFileSync(probe, `${event.systemPrompt}\n<<<END>>>\n`));
	// /pss-tools: the tools the model is offered right now, as a notice.
	pi.registerCommand("pss-tools", {
		description: "test: list active tools",
		handler: async (_args, ctx) => ctx.ui.notify(`active tools: ${pi.getActiveTools().join(",")}`, "info"),
	});
	// /pss-source <tool>: where that tool comes from now ("builtin:…" for pi's own), as a notice.
	pi.registerCommand("pss-source", {
		description: "test: a tool's source",
		handler: async (args, ctx) => {
			const tool = pi.getAllTools().find((t) => t.name === args.trim());
			ctx.ui.notify(`source ${args.trim()}: ${tool?.sourceInfo?.path ?? "none"}`, "info");
		},
	});
	pi.registerCommand("pss-tree", {
		description: "test: go to a point of the chat",
		handler: async (args, ctx) => {
			await ctx.navigateTree(args.trim(), { summarize: false });
		},
	});
}
