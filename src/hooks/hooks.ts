// pi's hooks that make home tools, messages and the model's view line up with the remote.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveRemote } from "../core/paths.ts";
import { swapNames } from "../core/textpaths.ts";
import { READ_ONLY, ROUTED } from "../routed/tools.ts";
import { MODEL_TOOLS } from "../model-tools.ts";
import type { Session } from "../sync/session.ts";

const routed = new Set<string>(ROUTED);
/** This extension's own tools: their inputs name machines and remote folders, never files to fetch. */
const own = new Set<string>(MODEL_TOOLS);

/** Text of a tool result or message content (string, or a list of parts). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n");
}

/** The same content with home names swapped for remote names (only text parts change). */
function swapContent<T>(content: T, names: Map<string, string>): T {
  if (typeof content === "string") return swapNames(content, names) as T;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = String((part as { text?: unknown }).text ?? "");
      const swapped = swapNames(text, names);
      return swapped === text ? part : { ...part, text: swapped };
    }
    return part;
  }) as T;
}

export function registerHooks(pi: ExtensionAPI, session: () => Session | undefined): void {
  // Before a tool runs.
  pi.on("tool_call", async (event) => {
    const s = session();
    if (!s?.usable || own.has(event.toolName)) return undefined;
    const input = event.input as Record<string, unknown>;
    if (routed.has(event.toolName)) {
      // pi expands `~` to the home machine's home folder; on the remote it means the remote's.
      if (typeof input.path === "string" && (input.path === "~" || input.path.startsWith("~/"))) input.path = resolveRemote(input.path, s.ws);
      return undefined;
    }
    const problem = await s.prepareCall(event.toolCallId, input);
    return problem ? { block: true, reason: problem } : undefined;
  });

  // After a tool ran. Tools that only read on the remote change nothing, so they need no sweep.
  pi.on("tool_result", async (event) => {
    const s = session();
    if (!s) return undefined;
    if (own.has(event.toolName)) return undefined;
    if (!routed.has(event.toolName)) await s.finishCall(event.toolCallId, textOf(event.content));
    if (!READ_ONLY.has(event.toolName)) await s.sweep();
    // A command may have switched the project's git branch (shown in the status line).
    if (event.toolName === "bash") await s.refreshBranch();
    return undefined;
  });

  // A message from an extension (e.g. a WhatsApp photo "saved at …"): the files it mentions move to the remote.
  // Messages you type are left alone: you already think in the remote's paths.
  pi.on("input", async (event) => {
    const s = session();
    if (!s?.usable) return { action: "continue" as const };
    if (event.source !== "interactive") await s.moveMentioned(event.text);
    await s.sweep();
    return { action: "continue" as const };
  });

  pi.on("turn_start", async () => {
    await session()?.sweep();
  });

  // The model works in the remote project, with the remote's instructions: the project's own copy of the global
  // AGENTS.md (in <project>/.pi/agent) and the AGENTS.md / CLAUDE.md files of the project and the folders above it.
  pi.on("before_agent_start", async (event) => {
    const s = session();
    const options = event.systemPromptOptions;
    if (!s || !options || typeof options !== "object") return undefined;
    options.cwd = s.ws.remoteProject;
    const files = await s.remoteContext();
    if (files) options.contextFiles = files;
    return undefined;
  });

  // What the model reads: every home name of a file on the remote is shown as its remote name. The chat file keeps the
  // original text, so other extensions (e.g. WhatsApp matching its messages) see what they wrote.
  pi.on("context", async (event) => {
    const s = session();
    if (!s) return undefined;
    const names = s.names();
    if (names.size === 0) return undefined;
    let changed = false;
    const messages = event.messages.map((m) => {
      const msg = m as { role?: string; content?: unknown };
      if (msg.role !== "user" && msg.role !== "toolResult" && msg.role !== "custom") return m;
      const content = swapContent(msg.content, names);
      if (content === msg.content) return m;
      changed = true;
      return { ...m, content } as typeof m;
    });
    return changed ? { messages } : undefined;
  });
}
