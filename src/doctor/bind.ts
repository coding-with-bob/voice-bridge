/**
 * The R-15 condition, in code: the Omnigent server runs without API auth, which is only
 * acceptable while it is bound to loopback. The integration contract requires re-verifying
 * this after every upgrade, so `bob doctor` checks it rather than trusting a past reading.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Bind hosts of the LISTEN rows in `lsof -nP -i :<port>` output. */
export function parseListenHosts(lsofOutput: string): string[] {
  const hosts: string[] = [];
  for (const line of lsofOutput.split("\n")) {
    if (!line.includes("(LISTEN)")) continue;
    const address = line.split(/\s+/).at(-2);
    if (address === undefined) continue;
    const host = hostOf(address);
    if (host !== null) hosts.push(host);
  }
  return hosts;
}

function hostOf(address: string): string | null {
  const bracketed = address.match(/^\[(.+)\]:\d+$/); // [::1]:6767
  if (bracketed) return bracketed[1]!;
  const separator = address.lastIndexOf(":");
  if (separator <= 0) return null;
  return address.slice(0, separator);
}

/** Empty means nothing is listening — which is a failure to verify, not a pass. */
export function isLocalhostOnly(hosts: string[]): boolean {
  return hosts.length > 0 && hosts.every((host) => LOOPBACK.has(host));
}

export async function readListenHosts(port: number): Promise<string[]> {
  const process = Bun.spawn(["lsof", "-nP", `-i:${port}`, "-sTCP:LISTEN"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  return parseListenHosts(stdout);
}
