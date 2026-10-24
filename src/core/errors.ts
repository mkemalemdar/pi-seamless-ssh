// Plain-language messages for what ssh reports, each saying what to do.

export interface SshProblem {
  /** Shown to the user. */
  message: string;
  /** Trying again can help (network trouble), as opposed to a refusal that won't change by itself. */
  retry: boolean;
}

const RULES: [RegExp, (machine: string) => SshProblem][] = [
  [/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i, (m) => ({
    message: `${m}'s host key has changed. That can mean the machine was reinstalled, or that someone is intercepting the connection. Check it, then remove the old key with: ssh-keygen -R <host>`,
    retry: false,
  })],
  [/Host key verification failed/i, (m) => ({ message: `${m}'s host key wasn't accepted, so nothing was connected.`, retry: false })],
  [/Permission denied|Too many authentication failures|Authentication failed/i, (m) => ({ message: `${m} refused the login: wrong password, or the key isn't allowed there.`, retry: false })],
  [/Could not resolve hostname|Name or service not known|nodename nor servname/i, (m) => ({ message: `"${m}" isn't a known machine name. Check the spelling, or add it to ~/.ssh/config.`, retry: false })],
  [/Connection refused/i, (m) => ({ message: `${m} is reachable but nothing accepts SSH on that port. Is the SSH server running?`, retry: true })],
  [/timed out|Operation timed out|Connection timeout/i, (m) => ({ message: `${m} didn't answer in time. Is it on, and on the network?`, retry: true })],
  [/No route to host|Network is unreachable|Network is down/i, (m) => ({ message: `${m} can't be reached from here (no network route).`, retry: true })],
  [/Connection closed|Connection reset|Broken pipe|closed by remote host/i, (m) => ({ message: `${m} closed the connection.`, retry: true })],
];

export function classifySsh(stderr: string, machine: string): SshProblem {
  for (const [re, make] of RULES) if (re.test(stderr)) return make(machine);
  const first = stderr.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("Warning: Permanently added"));
  return { message: first ? `${machine}: ${first}` : `Couldn't connect to ${machine}.`, retry: true };
}

/** Waits between reconnect tries, in seconds: about two minutes in all. */
export const RECONNECT_DELAYS = [1, 2, 5, 10, 30, 30, 30, 30];
