import { lookup } from "node:dns/promises"
import { connect } from "node:tls"
import { createResult, createResultError, type PromiseResult } from "#result"

export type RouteCheckProbeTls = {
  authorized: boolean
  validTo: string | null
  issuer: string | null
}

export type RouteCheckProbeRow = {
  hostname: string
  addresses: string[]
  tls: RouteCheckProbeTls | null
  httpStatus: number | null
  httpMs: number | null
  ok: boolean
  error: string | null
}

export type RouteCheckProbeDeps = {
  dnsLookup?: (hostname: string) => Promise<string[]>
  tlsHandshake?: (hostname: string, address: string) => Promise<RouteCheckProbeTls>
  httpFetch?: (hostname: string) => Promise<{ status: number; ms: number }>
}

const dnsTimeoutMs = 5_000
const tlsTimeoutMs = 8_000
const httpTimeoutMs = 12_000
const maximumHostnameLength = 253

function timeoutError(message: string): Error {
  return new Error(message)
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(message)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function dnsLookupDefault(hostname: string): Promise<string[]> {
  const records = await withTimeout(lookup(hostname, { all: true }), dnsTimeoutMs, "DNS lookup timed out.")
  const addresses = records.map((record) => record.address).filter((address) => address !== "")
  return [...new Set(addresses)]
}

async function tlsHandshakeDefault(hostname: string, address: string): Promise<RouteCheckProbeTls> {
  return withTimeout(
    new Promise<RouteCheckProbeTls>((resolve, reject) => {
      const socket = connect({ host: address, port: 443, servername: hostname, timeout: tlsTimeoutMs }, () => {
        const certificate: unknown = socket.getPeerCertificate()
        const issuer =
          typeof certificate === "object" && certificate !== null && "issuer" in certificate
            ? (certificate.issuer as Record<string, unknown>)
            : null
        const issuerName =
          issuer === null ? null : ([issuer.CN, issuer.O].find((part) => typeof part === "string") ?? null)
        const validTo =
          typeof certificate === "object" && certificate !== null && "valid_to" in certificate
            ? (certificate.valid_to ?? null)
            : null
        const tls = {
          authorized: socket.authorized,
          validTo: typeof validTo === "string" ? validTo : null,
          issuer: typeof issuerName === "string" ? issuerName : null,
        }
        socket.destroy()
        resolve(tls)
      })
      socket.on("error", (error) => {
        socket.destroy()
        reject(error)
      })
      socket.on("timeout", () => {
        socket.destroy()
        reject(timeoutError("TLS handshake timed out."))
      })
    }),
    tlsTimeoutMs + 2_000,
    "TLS handshake timed out.",
  )
}

async function httpFetchDefault(hostname: string): Promise<{ status: number; ms: number }> {
  const started = Date.now()
  const response = await fetch(`https://${hostname}/`, { signal: AbortSignal.timeout(httpTimeoutMs) })
  await response.body?.cancel()
  return { status: response.status, ms: Date.now() - started }
}

/**
 * Read-only health probe for one registered hostname, from this host's view:
 * DNS resolution, TLS handshake (trust + certificate identity), then one HTTPS
 * GET at `/`. Any HTTP status counts as reachable — API-style origins answer
 * 404 at `/` while serving normally, so only transport/TLS failures fail.
 */
export async function routeCheckProbe(
  hostname: string,
  deps: RouteCheckProbeDeps = {},
): PromiseResult<RouteCheckProbeRow> {
  const op = "routeCheckProbe"
  const name = hostname.trim().toLowerCase()
  if (name === "" || name.length > maximumHostnameLength || name.includes(" ")) {
    return createResultError(op, "Hostname is invalid.")
  }
  const dnsLookup = deps.dnsLookup ?? dnsLookupDefault
  let addresses: string[]
  try {
    addresses = await dnsLookup(name)
  } catch (error) {
    return createResult({
      hostname: name,
      addresses: [],
      tls: null,
      httpStatus: null,
      httpMs: null,
      ok: false,
      error: `DNS resolution failed: ${errorMessage(error)}`,
    })
  }
  if (addresses.length === 0) {
    return createResult({
      hostname: name,
      addresses: [],
      tls: null,
      httpStatus: null,
      httpMs: null,
      ok: false,
      error: "DNS resolution returned no addresses.",
    })
  }
  const address = addresses[0]!
  const tlsHandshake = deps.tlsHandshake ?? tlsHandshakeDefault
  let tls: RouteCheckProbeTls
  try {
    tls = await tlsHandshake(name, address)
  } catch (error) {
    return createResult({
      hostname: name,
      addresses,
      tls: null,
      httpStatus: null,
      httpMs: null,
      ok: false,
      error: `TLS handshake failed: ${errorMessage(error)}`,
    })
  }
  if (!tls.authorized) {
    return createResult({
      hostname: name,
      addresses,
      tls,
      httpStatus: null,
      httpMs: null,
      ok: false,
      error: "TLS certificate is not trusted.",
    })
  }
  const httpFetch = deps.httpFetch ?? httpFetchDefault
  try {
    const response = await httpFetch(name)
    return createResult({
      hostname: name,
      addresses,
      tls,
      httpStatus: response.status,
      httpMs: response.ms,
      ok: true,
      error: null,
    })
  } catch (error) {
    return createResult({
      hostname: name,
      addresses,
      tls,
      httpStatus: null,
      httpMs: null,
      ok: false,
      error: `HTTPS request failed: ${errorMessage(error)}`,
    })
  }
}
