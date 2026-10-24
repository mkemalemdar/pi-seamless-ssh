// The routed tools and `!command` while the connection is down: nothing runs, and never on this computer instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerRouted } from "../src/routed/tools.ts";

function wire(state: "reconnecting" | "lost") {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
  const handlers = new Map<string, (e: unknown) => unknown>();
  const pi = { registerTool: (t: { name: string; execute: never }) => tools.set(t.name, t), on: (event: string, h: never) => handlers.set(event, h) };
  const session = { usable: false, state, machine: "vm" };
  registerRouted(pi as never, () => session as never);
  return { tools, handlers };
}

test("while reconnecting or lost: tools refuse, and a !command is answered without running anywhere", async () => {
  for (const state of ["reconnecting", "lost"] as const) {
    const { tools, handlers } = wire(state);
    const why = state === "reconnecting" ? /dropped; reconnecting\. Nothing was run/ : /is lost\. Nothing was run/;
    await assert.rejects(tools.get("bash")!.execute("id", { command: "touch /tmp/should-not-exist" }, undefined, undefined, {}), why);
    const r = handlers.get("user_bash")!({ type: "user_bash", command: "hostname", cwd: process.cwd() }) as { result?: { output: string; cancelled: boolean }; operations?: unknown };
    assert.equal(r.operations, undefined, "no operations: pi would run them");
    assert.match(r.result!.output, why);
    assert.equal(r.result!.cancelled, true);
  }
});
