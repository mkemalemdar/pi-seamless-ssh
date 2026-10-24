// How ssh asks for a password or to trust a new host key without a terminal of its own: ssh runs a tiny helper
// (SSH_ASKPASS), the helper asks this extension over a private socket, and the extension shows pi's own dialog.
// The password goes straight from the dialog to ssh; it is never stored or written to the chat.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

/** Answers a prompt: the text to give ssh, or undefined to cancel. */
export type PromptHandler = (prompt: string) => Promise<string | undefined>;

const HELPER = `// pi-seamless-ssh askpass helper: forwards ssh's question to pi and prints the answer.
import { connect } from "node:net";
const socket = connect(process.env.PSS_ASKPASS_SOCKET ?? "");
let data = "";
socket.on("connect", () => socket.write(JSON.stringify({ prompt: process.argv[2] ?? "" }) + "\\n"));
socket.on("data", (chunk) => {
  data += chunk;
  const end = data.indexOf("\\n");
  if (end < 0) return;
  const reply = JSON.parse(data.slice(0, end));
  socket.end();
  if (typeof reply.answer === "string") { process.stdout.write(reply.answer + "\\n"); process.exit(0); }
  process.exit(1);
});
socket.on("error", () => process.exit(1));
`;

export class Askpass {
  /** True while a dialog is open, so connect time limits can pause. */
  pending = 0;
  readonly helperPath: string;
  readonly socketPath: string;
  private server: Server | undefined;
  private readonly handler: PromptHandler;

  /** `binDir` holds the helper script; `socketDir` is private (mode 700) and short enough for a socket path. */
  constructor(binDir: string, socketDir: string, id: string, handler: PromptHandler) {
    this.handler = handler;
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const script = join(binDir, "askpass.mjs");
    writeFileSync(script, HELPER, { mode: 0o600 });
    this.helperPath = join(binDir, "askpass");
    writeFileSync(this.helperPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o700 });
    chmodSync(this.helperPath, 0o700);
    this.socketPath = join(socketDir, `${id}.ask`);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => resolve());
    });
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  /** The environment ssh needs to use the helper. */
  env(): Record<string, string> {
    return {
      SSH_ASKPASS: this.helperPath,
      SSH_ASKPASS_REQUIRE: "force",
      // Older OpenSSH only uses SSH_ASKPASS when DISPLAY is set.
      DISPLAY: process.env.DISPLAY ?? ":0",
      PSS_ASKPASS_SOCKET: this.socketPath,
    };
  }

  private serve(socket: Socket): void {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      const end = data.indexOf("\n");
      if (end < 0) return;
      let prompt = "";
      try {
        prompt = String((JSON.parse(data.slice(0, end)) as { prompt?: unknown }).prompt ?? "");
      } catch {
        socket.end(`${JSON.stringify({ cancel: true })}\n`);
        return;
      }
      this.pending++;
      this.handler(prompt)
        .then((answer) => socket.end(`${JSON.stringify(answer === undefined ? { cancel: true } : { answer })}\n`))
        .catch(() => socket.end(`${JSON.stringify({ cancel: true })}\n`))
        .finally(() => this.pending--);
    });
    socket.on("error", () => {});
  }
}

/** ssh asks yes/no for a new host key, everything else is a password or passphrase. */
export const isHostKeyQuestion = (prompt: string): boolean => /continue connecting|yes\/no|fingerprint\]?\)?\??\s*$/i.test(prompt);
