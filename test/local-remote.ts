// A stand-in for the SSH connection that runs the remote scripts with this machine's /bin/sh. It lets the tests run
// every remote script for real (bash calls, listings, uploads) without a second machine.

import { spawn } from "node:child_process";
import { withLoginPath } from "../src/core/loginpath.ts";
import { BOOTSTRAP, framed, type Connection, type RunOptions, type RunResult } from "../src/ssh/connection.ts";
import { Remote } from "../src/ssh/remote.ts";

export class LocalConnection {
  machine = "test-machine";
  target = { destination: "test", label: "test-machine" };
  controlPath = "/nonexistent";
  usedPrompt = false;
  loginPath: string | undefined;
  alive = true;
  /** The "remote" shell's environment (e.g. another HOME, so tests never touch the real ~/.ssh). */
  env: NodeJS.ProcessEnv = process.env;
  private drop: (() => void) | undefined;

  isAlive(): boolean {
    return this.alive;
  }

  onDrop(handler: () => void): void {
    this.drop = handler;
  }

  /** Simulates the connection dying. */
  kill(): void {
    this.alive = false;
    this.drop?.();
  }

  run(script: string, options: RunOptions = {}): Promise<RunResult> {
    if (!this.alive) return Promise.reject(new Error("down"));
    return new Promise((resolve, reject) => {
      // Exactly like Connection.run: the login shell gets the bootstrap; the script, then the data, follow on the input.
      const child = spawn("/bin/sh", ["-c", BOOTSTRAP], { stdio: ["pipe", "pipe", "pipe"], env: this.env });
      const out: Buffer[] = [];
      let err = "";
      if (options.stdoutTo) child.stdout.pipe(options.stdoutTo);
      else child.stdout.on("data", (c: Buffer) => (options.onStdout ? options.onStdout(c) : out.push(c)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        options.onStderr?.(c);
        err += c;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
      child.stdin.on("error", () => {});
      const head = framed(withLoginPath(script, this.loginPath));
      const input = options.input;
      if (input === undefined) child.stdin.end(head);
      else if (typeof input === "string" || Buffer.isBuffer(input)) {
        child.stdin.write(head);
        child.stdin.end(input);
      } else {
        child.stdin.write(head);
        input.pipe(child.stdin);
      }
    });
  }

  async forward(): Promise<void> {}
  async close(): Promise<void> {
    this.alive = false;
  }
  async open(): Promise<void> {
    this.alive = true;
  }
}

export async function localRemote(): Promise<{ conn: LocalConnection; remote: Remote }> {
  const conn = new LocalConnection();
  const remote = new Remote(conn as unknown as Connection);
  await remote.probe();
  return { conn, remote };
}
