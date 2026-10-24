// What the extension asks of the remote, each as one short command over the shared connection.

import { applyListing, type DirsTree, dirsTreeScript, listScript, type Listing, parseDirsTree, type RemoteFile, type RemoteOs } from "../core/listing.ts";
import { loginPathScript, parseLoginPath } from "../core/loginpath.ts";
import { q } from "../core/shell.ts";
import type { Connection, RunOptions } from "./connection.ts";

export interface RemoteInfo {
  os: RemoteOs;
  home: string;
  hasBash: boolean;
  hasRg: boolean;
  hasGzip: boolean;
  /** Tools this extension needs that the remote lacks. */
  missing: string[];
}

/** What a path is on the remote: a file (with its size), a folder, missing with its folder there (something to save), or missing. */
export type PathKind = { kind: "file"; size: number } | { kind: "dir" } | { kind: "new" } | { kind: "none" };

const NEEDED = ["cat", "tar", "find", "sort", "comm", "dd", "mktemp", "tail", "head", "wc", "tr", "mkdir", "mv", "rm", "touch", "ps", "awk", "grep", "sed"];

export class Remote {
  readonly conn: Connection;
  info: RemoteInfo = { os: "other", home: "/", hasBash: false, hasRg: false, hasGzip: false, missing: [] };

  constructor(conn: Connection) {
    this.conn = conn;
  }

  /** Runs a script; a non-zero exit is an error with the remote's message. */
  async sh(script: string, options: RunOptions = {}): Promise<Buffer> {
    const r = await this.conn.run(script, options);
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").at(-1) || `the remote command failed (exit ${r.code})`);
    return r.stdout;
  }

  async probe(): Promise<RemoteInfo> {
    const has = (tool: string) => `command -v ${tool} >/dev/null 2>&1 && echo ${tool}=yes || echo ${tool}=no`;
    const script = [
      "uname -s",
      'printf "%s\\n" "$HOME"',
      has("bash"),
      has("rg"),
      has("gzip"),
      `for t in ${NEEDED.join(" ")}; do command -v "$t" >/dev/null 2>&1 || echo "missing=$t"; done`,
    ].join("\n");
    const lines = (await this.sh(script)).toString("utf8").split("\n");
    const uname = (lines[0] ?? "").trim().toLowerCase();
    this.info = {
      os: uname === "linux" ? "linux" : uname === "darwin" ? "darwin" : "other",
      home: (lines[1] ?? "/").trim() || "/",
      hasBash: lines.includes("bash=yes"),
      hasRg: lines.includes("rg=yes"),
      hasGzip: lines.includes("gzip=yes"),
      missing: lines.filter((l) => l.startsWith("missing=")).map((l) => l.slice(8)),
    };
    return this.info;
  }

  /** Reads your login shell's PATH there and gives it to every script after this; why not, when it can't. */
  async useLoginPath(seconds = 10): Promise<string | undefined> {
    let found: ReturnType<typeof parseLoginPath>;
    try {
      found = parseLoginPath((await this.sh(loginPathScript(seconds))).toString("utf8"), seconds);
    } catch (e) {
      found = { problem: (e as Error).message };
    }
    if ("problem" in found) return found.problem;
    this.conn.loginPath = found.path;
    return undefined;
  }

  readFile(path: string): Promise<Buffer> {
    return this.sh(`cat -- ${q(path)}`);
  }

  head(path: string, bytes: number): Promise<Buffer> {
    return this.sh(`head -c ${bytes} -- ${q(path)}`);
  }

  /** Writes in place, like pi's own write: an existing file keeps its permissions. */
  writeFile(path: string, data: Buffer | string): Promise<Buffer> {
    return this.sh(`cat > ${q(path)}`, { input: data });
  }

  mkdirp(dir: string): Promise<Buffer> {
    return this.sh(`mkdir -p -- ${q(dir)}`);
  }

  async test(flags: string, path: string): Promise<boolean> {
    const r = await this.conn.run(flags.split(" ").map((f) => `[ ${f} ${q(path)} ]`).join(" && "));
    return r.code === 0;
  }

  /** Several paths at once, in one command. */
  async kinds(paths: readonly string[]): Promise<PathKind[]> {
    if (paths.length === 0) return [];
    const script = paths
      .map((p) => `if [ -f ${q(p)} ]; then echo "file $(wc -c < ${q(p)} | tr -d ' ')"; elif [ -d ${q(p)} ]; then echo dir; elif [ -d "$(dirname -- ${q(p)})" ]; then echo new; else echo none; fi`)
      .join("\n");
    const lines = (await this.sh(script)).toString("utf8").split("\n");
    return paths.map((_, i): PathKind => {
      const line = lines[i] ?? "";
      if (line.startsWith("file ")) return { kind: "file", size: Number(line.slice(5)) || 0 };
      if (line === "dir" || line === "new") return { kind: line };
      return { kind: "none" };
    });
  }

  /** The agent folder's files: only the changes since `previous`, or everything when there is no previous view. */
  async listAgent(dir: string, stateFile: string, previous: ReadonlyMap<string, RemoteFile> | undefined): Promise<Listing> {
    const out = await this.sh(listScript(dir, stateFile, this.info.os, previous !== undefined));
    return applyListing(out.toString("utf8"), previous);
  }

  /** A folder's subfolders and theirs, in one command (for the folder browser). */
  async dirsTree(dir: string): Promise<DirsTree> {
    return parseDirsTree((await this.sh(dirsTreeScript(dir))).toString("utf8"));
  }

  /** Deletes several files in one command. */
  async removeAll(paths: readonly string[]): Promise<void> {
    if (paths.length) await this.sh(`rm -f -- ${paths.map(q).join(" ")}`);
  }

  /** Removes what a dropped connection may have left: half-done copies in the agent folder, old listing state files, old temp files. */
  cleanLeftovers(piDir: string): Promise<Buffer> {
    return this.sh(
      [
        `[ -d ${q(`${piDir}/agent`)} ] && find ${q(`${piDir}/agent`)} -name '*.pss-part' -type f -exec rm -f {} + 2>/dev/null`,
        `[ -d ${q(piDir)} ] && find ${q(piDir)} -maxdepth 1 -name '.pss-list-*' -type f -mmin +1440 -exec rm -f {} + 2>/dev/null`,
        `find "\${TMPDIR:-/tmp}" -maxdepth 1 -user "$(id -u)" \\( -name 'pss-out.*' -o -name 'pss-cmd.*' -o -name 'pss-up.*' \\) -mmin +1440 -exec rm -rf {} + 2>/dev/null`,
        `true`,
      ].join("\n"),
    );
  }
}
