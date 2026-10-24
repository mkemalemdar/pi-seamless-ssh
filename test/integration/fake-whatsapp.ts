// A stand-in for pi-harness-whatsapp, for the integration test. It does the two file things the real one does, the
// same way the real code does them:
//   /fakewa-photo   "receives" a photo: saves it in its inbox under pi's agent folder and hands pi a message
//                   "... saved at <path>]" with pi.sendUserMessage (followUp), like bridge.ts/media.ts
//   whatsapp_send_image(path)  reads the file from home with statSync + readFileSync relative to ctx.cwd, like tools.ts,
//                   and logs what it "sent" to FAKE_WA_LOG
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// A valid 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export default function (pi: ExtensionAPI) {
	const log = (entry: unknown) => appendFileSync(process.env.FAKE_WA_LOG ?? "/dev/null", `${JSON.stringify(entry)}\n`);

	pi.registerCommand("fakewa-photo", {
		description: "test: receive a WhatsApp photo",
		handler: async (_args, _ctx) => {
			const inbox = join(getAgentDir(), "pi-harness-whatsapp", "inbox");
			mkdirSync(inbox, { recursive: true, mode: 0o700 });
			const path = join(inbox, "photo-from-ali.png");
			writeFileSync(path, PNG, { mode: 0o600 });
			log({ received: path, bytes: PNG.length });
			pi.sendUserMessage(
				`[WhatsApp from Ali] [sent a file: photo-from-ali.png (image/png, 1 KB), saved at ${path}] What kind of file is this and how many bytes is it? Check with the bash tool (file and wc -c) on the path given.`,
				{ deliverAs: "followUp" },
			);
		},
	});

	pi.registerTool({
		name: "whatsapp_send_image",
		label: "WhatsApp: send image",
		description: "Send an image file (e.g. a screenshot) to WhatsApp.",
		parameters: Type.Object({ path: Type.String({ description: "Path to the file" }), caption: Type.Optional(Type.String()) }),
		async execute(_id, params, _signal, _update, ctx) {
			const full = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
			const size = statSync(full).size;
			const data = readFileSync(full);
			log({ sent: params.path, opened: full, size, bytes: data.length, sha: createHash("sha256").update(data).digest("hex"), text: data.toString("utf8").slice(0, 64) });
			return { content: [{ type: "text", text: `Sent ${params.path} (${data.length} bytes) to WhatsApp.` }], details: undefined };
		},
	});
}
