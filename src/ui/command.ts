// /ssh                     the panel: recent connections, machines, settings
// /ssh <machine>           connect (a saved name, user@address, user@address:port, or a ~/.ssh/config name), then
//                          pick the project folder
// /ssh <machine> <folder>  connect straight into that folder (~ is the remote's home)
// /ssh off                 back to this computer
// /ssh status              where the chat is working

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Controller } from "../controller.ts";
import { dialogUI } from "./connect-ui.ts";
import { showPanel } from "./panel.ts";

export function registerCommand(pi: ExtensionAPI, c: Controller): void {
  pi.registerCommand("ssh", {
    description: "Work on another machine over SSH: /ssh, /ssh <machine> [folder], /ssh off",
    getArgumentCompletions: (prefix) => {
      const p = prefix.trim();
      const names = [...c.settings.machines.map((m) => m.name), ...c.settings.recent.map((r) => r.address), ...c.sshConfigHosts(), "off", "status"];
      const items = [...new Set(names)].filter((s) => s.startsWith(p)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      c.track(ctx);
      const arg = args.trim();
      const tui = ctx.hasUI && ctx.mode === "tui";
      if (arg === "off") return void (await c.disconnect(ctx));
      if (arg === "status") return ctx.ui.notify(statusText(c), "info");
      if (arg) {
        const [machine, ...rest] = arg.split(/\s+/);
        const project = rest.join(" ").trim() || undefined;
        if (tui) return showPanel(ctx, c, { connect: { address: machine!, ...(project ? { project } : {}) } });
        return void (await c.connect(ctx, machine!, project, dialogUI(ctx)));
      }
      if (!tui) return ctx.ui.notify(`${statusText(c)}\nUse /ssh <machine> <folder> or /ssh off.`, "info");
      await showPanel(ctx, c);
    },
  });
}

function statusText(c: Controller): string {
  const s = c.session;
  if (!s) return "Not connected: the model works on this computer.";
  return `Connected to ${c.label(s.machine)} (${s.state}). The model works in ${s.ws.remoteProject}; the project's pi files are in ${s.ws.remoteProject}/.pi/agent.`;
}
