import { isIP } from "node:net"
import { connect } from "node:tls"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"

const defaultPort = 443
const defaultTimeoutMs = 15_000

/**
 * A trust-only TLS probe against the tailnet node: connects to the node
 * address with the hostname as SNI and verifies the certificate chain
 * against the system trust store (plus optional extra `ca` anchors for
 * tests). No HTTP is exchanged: any served content would be fine because
 * trust, not content, is the gate — mirroring the `~/ds`
 * `leoBatchTrustedTlsCheck` (`curl --resolve` without `--insecure`).
 *
 * There is deliberately no insecure option: `rejectUnauthorized` stays
 * enabled and an unauthorized socket refuses. Failures name the hostname
 * and the failure class only, never certificate contents or key material.
 */
export function tailscaleTlsTrustProbeCreate(options: {
  nodeAddress: unknown
  port?: unknown
  timeoutMs?: unknown
  ca?: string | readonly string[]
  op?: string
}): Result<{ probe(hostname: string): PromiseResult<"trusted"> }> {
  const op = options?.op ?? "tailscaleTlsTrustProbeCreate"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "TLS trust probe options are required")
  }
  if (typeof options.nodeAddress !== "string" || isIP(options.nodeAddress.trim()) !== 4) {
    return createResultError(op, "TLS trust probe node address must be an IPv4 address")
  }
  const nodeAddress = options.nodeAddress.trim()
  const port = options.port ?? defaultPort
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return createResultError(op, "TLS trust probe port must be between 1 and 65535")
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return createResultError(op, "TLS trust probe timeout must be a positive integer")
  }
  if (
    options.ca !== undefined &&
    !(
      typeof options.ca === "string" ||
      (Array.isArray(options.ca) && options.ca.every((entry) => typeof entry === "string"))
    )
  ) {
    return createResultError(op, "TLS trust probe certificate authorities are invalid")
  }
  const ca = options.ca === undefined ? undefined : Array.isArray(options.ca) ? [...options.ca] : options.ca

  return createResult({
    probe(hostname: string): PromiseResult<"trusted"> {
      if (typeof hostname !== "string" || hostname.trim() === "" || isIP(hostname.trim()) !== 0) {
        return Promise.resolve(createResultError(op, "TLS trust probe hostname must be a DNS name"))
      }
      const servername = hostname.trim()
      return new Promise((resolve) => {
        let settled = false
        const finish = (result: ReturnType<typeof createResult<"trusted">> | ReturnType<typeof createResultError>) => {
          if (settled) return
          settled = true
          try {
            socket.destroy()
          } catch {
            // The verdict stands even when the socket refuses to close.
          }
          resolve(result)
        }
        let socket: ReturnType<typeof connect>
        try {
          socket = connect({
            host: nodeAddress,
            port,
            servername,
            timeout: timeoutMs,
            ...(ca === undefined ? {} : { ca }),
          })
        } catch {
          finish(createResultError(op, `no trusted TLS for "${servername}": connection failed`))
          return
        }
        socket.once("secureConnect", () => {
          if (socket.authorized) {
            finish(createResult("trusted"))
            return
          }
          finish(createResultError(op, `no trusted TLS for "${servername}": certificate is not trusted`))
        })
        socket.once("timeout", () => {
          finish(createResultError(op, `no trusted TLS for "${servername}": connection timed out`))
        })
        socket.once("error", () => {
          finish(createResultError(op, `no trusted TLS for "${servername}": connection failed`))
        })
      })
    },
  })
}
