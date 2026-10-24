// Key login, set up once over a connection made with a password (what `ssh-copy-id` does): this computer's public key
// is added to the machine's ~/.ssh/authorized_keys, so ssh logs in with the key next time. When this computer has no
// key yet, one is made (~/.ssh/id_ed25519, no passphrase), which ssh uses by default.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import type { Remote } from "./remote.ts";

const KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];

/** This computer's public key, made first if there is none. */
export function localPublicKey(): { key: string; made: boolean } {
  const dir = join(homedir(), ".ssh");
  for (const name of KEYS) {
    const pub = join(dir, `${name}.pub`);
    if (existsSync(pub) && existsSync(join(dir, name))) return { key: readFileSync(pub, "utf8").trim(), made: false };
  }
  const file = join(dir, "id_ed25519");
  if (existsSync(file)) throw new Error(`${file} exists without its .pub file; can't add it`);
  // ssh-keygen doesn't make the folder; ssh wants it private.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `${userInfo().username}@${hostname()} (pi-seamless-ssh)`, "-f", file], { stdio: "ignore" });
  return { key: readFileSync(`${file}.pub`, "utf8").trim(), made: true };
}

/** Adds `key` to the machine's authorized_keys (once), with the permissions sshd requires. */
export async function installKey(remote: Remote, key: string): Promise<void> {
  await remote.sh(
    [
      `k=$(cat)`,
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
      `grep -qxF -- "$k" ~/.ssh/authorized_keys || printf '%s\\n' "$k" >> ~/.ssh/authorized_keys`,
    ].join("\n"),
    { input: `${key}\n` },
  );
}
