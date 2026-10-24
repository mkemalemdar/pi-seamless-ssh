// Moving files between home and the remote: any number of files in one `tar` stream over the shared connection
// (one command, not one per file), compressed when that pays off. On the remote nothing is ever half written: each
// file is checked for size, put next to its target under a temporary name, then renamed into place. tar keeps each
// file's date.

import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { copyFileSync, existsSync, linkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { worthCompressing } from "../core/compress.ts";
import { q } from "../core/shell.ts";
import type { Scratch } from "../sync/scratch.ts";
import type { Remote } from "./remote.ts";

export interface Upload {
  /** A home file, or the data itself. */
  from: { path: string } | { data: Buffer };
  /** Absolute path on the remote. */
  to: string;
  /** The date the remote file gets (whole seconds). */
  mtime: number;
}

export interface Download {
  /** Absolute path on the remote. */
  from: string;
  /** Where it goes on home. */
  to: string;
  /** Known size, if any: used to decide compression. */
  size?: number;
}

export type Outcome = { ok: true } | { ok: false; error: string };

/** How far a transfer is: bytes moved so far, of about `total`. */
export type Progress = (done: number, total: number) => void;

/** Passes data through, counting it. */
function counter(total: number, onProgress: Progress | undefined): Transform {
  let done = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, next) {
      done += chunk.length;
      onProgress?.(Math.min(done, total), total);
      next(null, chunk);
    },
  });
}

/** Both sides can gzip (checked once per home). */
let homeGzip: boolean | undefined;
function hasGzipHome(): boolean {
  if (homeGzip === undefined) homeGzip = (process.env.PATH ?? "").split(":").some((dir) => existsSync(join(dir, "gzip")));
  return homeGzip;
}

/** Runs home's tar: no macOS resource-fork files (._name), no extended attributes. */
function homeTar(args: string[]) {
  return spawn("tar", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
}

function waitExit(child: ReturnType<typeof spawn>, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = "";
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.once("error", (e) => reject(new Error(`${what}: ${e.message}`)));
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${what} failed: ${err.trim().split("\n").at(-1) ?? `exit ${code}`}`))));
  });
}

export async function uploadMany(remote: Remote, items: readonly Upload[], scratch: Scratch, onProgress?: Progress): Promise<Outcome[]> {
  if (items.length === 0) return [];
  const sizes = items.map((it) => ("data" in it.from ? it.from.data.length : statSync(it.from.path).size));
  const total = sizes.reduce((a, b) => a + b, 0);
  const stage = scratch.dir(total);
  try {
    // Staged under their number, so names, folders and lengths never matter to tar.
    items.forEach((it, i) => {
      const staged = join(stage, String(i));
      if ("data" in it.from) {
        writeFileSync(staged, it.from.data);
        utimesSync(staged, it.mtime, it.mtime);
        return;
      }
      // A hard link costs nothing, but shares the file's date: only when the date is already the one wanted.
      if (Math.floor(statSync(it.from.path).mtimeMs / 1000) === it.mtime) {
        try {
          linkSync(it.from.path, staged);
          return;
        } catch {
          // Another file system: copy below.
        }
      }
      copyFileSync(it.from.path, staged);
      utimesSync(staged, it.mtime, it.mtime);
    });
    const gzip = remote.info.hasGzip && hasGzipHome() && worthCompressing(items.map((it, i) => ({ name: it.to, size: sizes[i]! })));
    // Packed, counted (before compressing, so the progress is in real bytes), then compressed in its own step.
    const tar = homeTar(["-cf", "-", "--format=ustar", "-C", stage, ...items.map((_, i) => String(i))]);
    const tarDone = waitExit(tar, "packing the files on this machine");
    const counted = tar.stdout!.pipe(counter(total, onProgress));
    let stream: NodeJS.ReadableStream = counted;
    let gzipDone: Promise<void> = Promise.resolve();
    if (gzip) {
      const z = spawn("gzip", ["-1"], { stdio: ["pipe", "pipe", "pipe"] });
      gzipDone = waitExit(z, "compressing on this machine");
      counted.pipe(z.stdin);
      stream = z.stdout;
    }
    const lines = [
      `T=$(mktemp -d "\${TMPDIR:-/tmp}/pss-up.XXXXXX") || exit 1`,
      `tar ${gzip ? "-xzf" : "-xf"} - -C "$T" || { rm -rf "$T"; exit 1; }`,
      ...items.map((it, i) => {
        const part = q(`${it.to}.pss-part`);
        return `mkdir -p -- ${q(posix.dirname(it.to))} && [ "$(wc -c < "$T/${i}" | tr -d ' ')" = ${sizes[i]} ] && mv -f "$T/${i}" ${part} && mv -f ${part} ${q(it.to)} && echo "PSS_OK ${i}" || { rm -f ${part}; echo "PSS_FAIL ${i}"; }`;
      }),
      `rm -rf "$T"`,
    ];
    const run = remote.conn.run(lines.join("\n"), { input: stream as never });
    const [result] = await Promise.all([run, tarDone, gzipDone]);
    const out = result.stdout.toString("utf8");
    return items.map((_, i) =>
      out.includes(`PSS_OK ${i}\n`) ? { ok: true } : { ok: false, error: result.code === 0 ? "the copy on the remote failed (size check or no space)" : result.stderr.trim().split("\n").at(-1) || "the copy failed" },
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function downloadMany(remote: Remote, items: readonly Download[], scratch: Scratch, onProgress?: Progress): Promise<Outcome[]> {
  if (items.length === 0) return [];
  const total = items.reduce((sum, it) => sum + (it.size ?? 0), 0);
  const stage = scratch.dir(total);
  try {
    const gzip = remote.info.hasGzip && hasGzipHome() && items.every((it) => it.size !== undefined) && worthCompressing(items.map((it) => ({ name: it.from, size: it.size! })));
    const rels = items.map((it) => it.from.replace(/^\/+/, ""));
    const create = remote.info.os === "darwin" ? `COPYFILE_DISABLE=1 tar --no-xattrs ${gzip ? "-czf" : "-cf"}` : `tar ${gzip ? "-czf" : "-cf"}`;
    // Received, decompressed in its own step, counted (in real bytes), then unpacked.
    const tar = homeTar(["-xf", "-", "-C", stage]);
    const tarDone = waitExit(tar, "unpacking the files on this machine");
    const count = counter(total, onProgress);
    count.pipe(tar.stdin!);
    let into: NodeJS.WritableStream = count;
    let gunzipDone: Promise<void> = Promise.resolve();
    if (gzip) {
      const z = spawn("gzip", ["-d"], { stdio: ["pipe", "pipe", "pipe"] });
      gunzipDone = waitExit(z, "decompressing on this machine");
      z.stdout.pipe(count);
      into = z.stdin;
    }
    const [result] = await Promise.all([remote.conn.run(`cd / && ${create} - -- ${rels.map(q).join(" ")}`, { stdoutTo: into as never }), tarDone, gunzipDone]);
    return items.map((it, i) => {
      const staged = join(stage, rels[i]!);
      if (!existsSync(staged)) return { ok: false, error: result.stderr.trim().split("\n").at(-1) || "not received" };
      try {
        renameSync(staged, it.to);
      } catch {
        // Another file system (RAM to disk): copy, keeping the date.
        const st = statSync(staged);
        copyFileSync(staged, it.to);
        utimesSync(it.to, st.atime, st.mtime);
      }
      return { ok: true };
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
