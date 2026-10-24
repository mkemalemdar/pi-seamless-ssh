// pi's bash tool, run on the remote.
//
// The command's output goes to a file on the remote, and a small loop sends what's new every 0.1 s. That way:
// - `npm run dev &` doesn't hang the call: the call ends when the command's shell exits, and a background program
//   keeps writing to the file, not to the connection, so it keeps running after the call;
// - everything the command printed before it exited is sent (a last send after it ends);
// - Esc or a timeout stops the command and everything it started (its whole process tree, found with `ps`, which works
//   the same on Linux and macOS), politely first, forced after 1 s.
//
// sudo: there is no terminal on the remote, so `sudo` there can't ask for a password itself. For the command, `sudo`
// is a small stand-in that runs the real sudo with -A and a password helper; the helper asks this computer (through
// the script's stderr), pi shows the password box, and the answer comes back over the connection into a pipe only the
// helper reads. Everything lives in the call's own temporary folder, removed when the call ends.

import { randomBytes } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { q } from "../core/shell.ts";
import type { Remote } from "../ssh/remote.ts";

const PID = "PSS_PID ";
const EXIT = "PSS_EXIT ";
const DIR = "PSS_DIR ";
const SUDO = "PSS_SUDO ";

/** sudo asking for a password, as the helper reports it. */
export interface SudoRequest {
  /** sudo's prompt, e.g. "[sudo] password for me: ". */
  prompt: string;
  /** The command that ran sudo (the whole bash call). */
  command: string;
  /** The same sudo asking again: the last answer was wrong. */
  retry: boolean;
  /** Aborted when the call ends: the question is no longer needed. */
  signal: AbortSignal;
}

/** The password for a sudo request, or undefined to refuse. */
export type SudoAsk = (request: SudoRequest) => Promise<string | undefined>;

// The password helper sudo runs (-A): its own pipe, the question to the call's script, the answer read from the pipe.
const ASKPASS = [
  "#!/bin/sh",
  'd=$(dirname "$0")',
  'f="$d/a.$$"',
  'mkfifo -m 600 "$f" || exit 1',
  // Held open both ways, so the answer can be written before or after this reads it.
  'exec 4<>"$f"',
  `printf '%s %s %s\\n' "$$" "$PPID" "$(printf '%s' "$1" | tr '\\n\\t' '  ')" > "$d/ask"`,
  "IFS= read -r a <&4",
  'rm -f "$f"',
  `case "$a" in y*) printf '%s\\n' "\${a#y}" ;; *) echo "sudo: the password was not given (declined on the computer running pi)" >&2; exit 1 ;; esac`,
].join("\n");

// `sudo` for the command: the real one, asking through the helper.
const SUDO_STANDIN = ["#!/bin/sh", 'h=$(dirname "$0")/..', 'SUDO_ASKPASS="$h/askpass" exec "$(cat "$h/real")" -A "$@"'].join("\n");

/**
 * The remote script for one bash call. The command is run from a temporary file (and the script itself arrives on the
 * remote shell's input), so the command's text is in no process's argument list: `pkill -f <pattern>` in a command
 * can't hit the script that runs it.
 */
export function bashScript(command: string, cwd: string, useBash: boolean): string {
  const shell = useBash ? "bash" : "sh";
  let end = `PSS_CMD_${randomBytes(8).toString("hex")}`;
  while (command.includes(end)) end = `PSS_CMD_${randomBytes(8).toString("hex")}`;
  return [
    `cd -- ${q(cwd)} || { echo "Working directory does not exist: ${cwd.replace(/"/g, '\\"')}" >&2; exit 1; }`,
    `d=$(mktemp -d "\${TMPDIR:-/tmp}/pss-run.XXXXXX") || exit 1`,
    `printf '${DIR}%s\\n' "$d" >&2`,
    `f="$d/out"; c="$d/cmd"`,
    `echo 0 > "$d/off"`,
    `cat > "$c" <<'${end}'`,
    command,
    end,
    // sudo through this computer, when the machine has sudo
    `p="$PATH"; asker=`,
    `if real=$(command -v sudo 2>/dev/null) && mkfifo -m 600 "$d/ask" 2>/dev/null && mkdir "$d/bin"; then`,
    `  printf '%s' "$real" > "$d/real"`,
    `  printf '%s\\n' ${q(ASKPASS)} > "$d/askpass"; printf '%s\\n' ${q(SUDO_STANDIN)} > "$d/bin/sudo"`,
    `  chmod 700 "$d/askpass" "$d/bin/sudo"; p="$d/bin:$PATH"`,
    `  ( while :; do if IFS= read -r line < "$d/ask"; then printf '${SUDO}%s\\n' "$line" >&2; fi; done ) & asker=$!`,
    `fi`,
    // send: everything new since the last offset
    `send() { off=$(cat "$d/off"); sz=$(wc -c < "$f" | tr -d ' '); if [ "$sz" -gt "$off" ]; then tail -c +$((off + 1)) "$f" | head -c $((sz - off)); echo "$sz" > "$d/off"; fi; }`,
    `PATH="$p" ${shell} "$c" > "$f" 2>&1 < /dev/null &`,
    `pid=$!`,
    `printf '${PID}%s\\n' "$pid" >&2`,
    // The loop is asked to stop, never killed: killed in the middle of a send, the part it was sending would be sent again.
    `( while [ ! -e "$d/stop" ]; do send; sleep 0.1; done ) & loop=$!`,
    `wait "$pid"; code=$?`,
    `: > "$d/stop"; wait "$loop"`,
    `kill $asker 2>/dev/null; wait $asker 2>/dev/null`,
    `send`,
    `rm -rf -- "$d"`,
    `printf '${EXIT}%s\\n' "$code" >&2`,
    `exit 0`,
  ].join("\n");
}

/**
 * Stops a command and everything it started: the whole tree is listed first (so no child escapes when its parent
 * dies), then sent TERM, and after 1 s KILL.
 */
export const stopScript = (pid: number): string =>
  [
    `tree() { echo "$1"; for c in $(ps -A -o pid= -o ppid= | awk -v p="$1" '$2 == p { print $1 }'); do tree "$c"; done; }`,
    `pids=$(tree ${pid})`,
    `kill -TERM $pids 2>/dev/null`,
    `sleep 1`,
    `kill -KILL $pids 2>/dev/null`,
    `true`,
  ].join("\n");

/** Writes the answer into the helper's pipe (opened both ways, so it never waits for a reader). */
export const answerScript = (dir: string, helper: number): string => {
  const f = q(`${dir}/a.${helper}`);
  return `[ -p ${f} ] || exit 0\nexec 3<>${f} && cat >&3`;
};

export function remoteBashOps(remote: () => Remote, sudo?: SudoAsk): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const r = remote();
        let pid: number | undefined;
        let exit: number | undefined;
        let stderrBuf = "";
        let dir: string | undefined;
        let stopped: "aborted" | "timeout" | undefined;
        // sudo questions end with the call; a sudo asking again means the last answer was wrong.
        const questions = new AbortController();
        const answered = new Set<number>();
        const answerSudo = (line: string) => {
          const m = /^(\d+) (\d+) (.*)$/.exec(line);
          if (!m || !dir) return;
          const [helper, sudoPid, prompt] = [Number(m[1]), Number(m[2]), m[3]!];
          const retry = answered.has(sudoPid);
          answered.add(sudoPid);
          const at = dir;
          void (async () => {
            const password = sudo && !questions.signal.aborted ? await sudo({ prompt, command, retry, signal: questions.signal }).catch(() => undefined) : undefined;
            await r.conn.run(answerScript(at, helper), { input: password === undefined ? "n\n" : `y${password}\n` }).catch(() => {});
          })();
        };
        const stop = (why: "aborted" | "timeout") => {
          if (stopped) return;
          stopped = why;
          if (pid !== undefined) r.conn.run(stopScript(pid)).catch(() => {});
        };
        const onAbort = () => stop("aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = timeout && timeout > 0 ? setTimeout(() => stop("timeout"), timeout * 1000) : undefined;
        r.conn
          .run(bashScript(command, cwd, r.info.hasBash), {
            onStdout: onData,
            onStderr: (chunk) => {
              stderrBuf += chunk;
              const lines = stderrBuf.split("\n");
              stderrBuf = lines.pop() ?? "";
              for (const line of lines) {
                if (line.startsWith(PID)) pid = Number(line.slice(PID.length));
                else if (line.startsWith(DIR)) dir = line.slice(DIR.length);
                else if (line.startsWith(SUDO)) answerSudo(line.slice(SUDO.length));
                else if (line.startsWith(EXIT)) exit = Number(line.slice(EXIT.length));
                else onData(Buffer.from(`${line}\n`));
              }
              if (stopped && pid !== undefined) stop(stopped);
            },
          })
          .then((result) => {
            questions.abort();
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (stopped === "aborted") return reject(new Error("aborted"));
            if (stopped === "timeout") return reject(new Error(`timeout:${timeout}`));
            if (exit === undefined) {
              const why = result.stderr.trim().split("\n").filter((l) => ![PID, DIR, SUDO].some((m) => l.startsWith(m))).at(-1);
              if (why) return reject(new Error(`The command couldn't run on the remote: ${why}`));
              return reject(new Error(`The command stopped the shell that was running it (exit ${result.code ?? "by signal"}).`));
            }
            resolve({ exitCode: exit });
          })
          .catch((error: Error) => {
            questions.abort();
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          });
      }),
  };
}
