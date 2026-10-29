import { createResult, createResultError, type PromiseResult } from "#result"

/**
 * Default resolver reload runner: restart the dedicated private-dnsmasq
 * systemd unit so it picks up the rewritten conf file (dnsmasq does not
 * re-read its conf file on SIGHUP/reload; only a restart applies it). Only
 * invoked after a successful config write, and only while private DNS is
 * enabled. Failure output is truncated and never contains credentials.
 */
export function projectRegistryDaemonPrivateDnsResolverReloadDefault(
  unit = "leo-tailscale-private-dns",
): () => PromiseResult<void> {
  return async () => {
    const op = "projectRegistryDaemonPrivateDnsResolverReload"
    try {
      const proc = Bun.spawn(["systemctl", "restart", unit], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (exitCode !== 0) {
        const detail = (stderr || stdout).trim().slice(0, 200)
        return createResultError(
          op,
          detail === "" ? `dnsmasq unit ${unit} restart failed` : `dnsmasq unit ${unit} restart failed: ${detail}`,
        )
      }
      return createResult(undefined)
    } catch {
      return createResultError(op, `dnsmasq unit ${unit} restart failed`)
    }
  }
}
