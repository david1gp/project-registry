import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import { projectDomainNormalize } from "./projectDomainNormalize.js"

/**
 * The tracker's published TLS readiness: multi-level enrollments, the
 * wildcard-covered single-level names, and the hostnames with a proven
 * trusted handshake. The regenerate hook reads this snapshot; the tracker
 * replaces it atomically after every drain, never mutating it in place.
 */
export type ProjectPrivateTlsGateSnapshot = {
  enrolled: readonly string[]
  wildcardCovered: readonly string[]
  proven: readonly string[]
}

export type ProjectPrivateTlsGateRefusal = {
  hostname: string
  reason: string
}

export type ProjectPrivateTlsGateDecision = {
  allowed: string[]
  refused: ProjectPrivateTlsGateRefusal[]
}

function snapshotList(value: unknown, field: string, op: string): Result<string[]> {
  if (!Array.isArray(value)) {
    return createResultError(op, `private TLS gate snapshot ${field} is invalid`)
  }
  for (const entry of value) {
    if (typeof entry !== "string") return createResultError(op, `private TLS gate snapshot ${field} is invalid`)
  }
  return createResult([...value])
}

/**
 * Decide which private names the private Caddy may serve. A name is
 * served only when its enrollment is proven: multi-level names need
 * per-host enrollment plus a trusted handshake; single-level names ride
 * the zone wildcard but still need their own trusted handshake.
 * Unknown names (not yet seen by the tracker) are refused: enrollment
 * always precedes routes.
 */
export function projectPrivateTlsGateDecide(options: {
  hostnames: unknown
  snapshot: unknown
  op?: string
}): Result<ProjectPrivateTlsGateDecision> {
  const op = options?.op ?? "projectPrivateTlsGateDecide"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "private TLS gate options are required")
  }
  if (!Array.isArray(options.hostnames)) return createResultError(op, "private TLS gate hostnames are required")
  if (typeof options.snapshot !== "object" || options.snapshot === null) {
    return createResultError(op, "private TLS gate snapshot is required")
  }
  const snapshot = options.snapshot as Record<string, unknown>
  const enrolledR = snapshotList(snapshot.enrolled, "enrolled", op)
  if (!enrolledR.success) return enrolledR
  const wildcardR = snapshotList(snapshot.wildcardCovered, "wildcardCovered", op)
  if (!wildcardR.success) return wildcardR
  const provenR = snapshotList(snapshot.proven, "proven", op)
  if (!provenR.success) return provenR

  const seen = new Set<string>()
  const hostnames: string[] = []
  for (const entry of options.hostnames) {
    if (typeof entry !== "string") return createResultError(op, "private TLS gate hostnames must be strings")
    const hostname = projectDomainNormalize(entry)
    if (hostname === "") return createResultError(op, "private TLS gate cannot judge an empty hostname")
    if (seen.has(hostname)) continue
    seen.add(hostname)
    hostnames.push(hostname)
  }

  const enrolled = new Set(enrolledR.data)
  const wildcardCovered = new Set(wildcardR.data)
  const proven = new Set(provenR.data)
  const allowed: string[] = []
  const refused: ProjectPrivateTlsGateRefusal[] = []
  for (const hostname of hostnames.sort()) {
    if (!enrolled.has(hostname) && !wildcardCovered.has(hostname)) {
      refused.push({
        hostname,
        reason: `private name "${hostname}" is not enrolled for TLS and not wildcard-covered; refusing to serve before enrollment`,
      })
      continue
    }
    if (!proven.has(hostname)) {
      refused.push({
        hostname,
        reason: `private name "${hostname}" has no proven trusted TLS handshake; refusing to serve before proof`,
      })
      continue
    }
    allowed.push(hostname)
  }
  return createResult({ allowed, refused })
}

export type ProjectPrivateTlsTrustProbe = (hostname: string) => PromiseResult<"trusted">

function delayValidate(value: unknown, field: string, op: string): Result<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return createResultError(op, `private TLS trust ${field} must be a non-negative integer`)
  }
  return createResult(value)
}

/**
 * Bounded trusted-TLS readiness for exact hostnames, mirroring the `~/ds`
 * `leoBatchTrustedTlsCheck`: the probe must verify the certificate chain
 * (never `--insecure`), while any served content is fine because trust,
 * not content, is the gate. Issuance can lag a regenerate, so callers
 * pass `waitMs` for bounded retries; the default 0 probes once and
 * refuses immediately so a not-ready certificate never delays a refusal.
 * Names nothing but hostnames; carries no secrets.
 */
export async function projectPrivateTlsTrustedCheck(options: {
  probe: ProjectPrivateTlsTrustProbe
  hostnames: readonly string[]
  waitMs?: number
  pollMs?: number
  clock?: () => number
  sleep?: (delayMs: number) => Promise<void>
  op?: string
}): PromiseResult<"trusted"> {
  const op = options?.op ?? "projectPrivateTlsTrustedCheck"
  if (typeof options !== "object" || options === null) {
    return createResultError(op, "private TLS trust options are required")
  }
  if (typeof options.probe !== "function") return createResultError(op, "private TLS trust probe is required")
  if (!Array.isArray(options.hostnames)) return createResultError(op, "private TLS trust hostnames are required")
  for (const entry of options.hostnames) {
    if (typeof entry !== "string" || entry === "") {
      return createResultError(op, "private TLS trust hostnames must be non-empty strings")
    }
  }
  const waitR = delayValidate(options.waitMs ?? 0, "waitMs", op)
  if (!waitR.success) return waitR
  const pollR = delayValidate(options.pollMs ?? 5_000, "pollMs", op)
  if (!pollR.success) return pollR
  if (options.clock !== undefined && typeof options.clock !== "function") {
    return createResultError(op, "private TLS trust clock is invalid")
  }
  if (options.sleep !== undefined && typeof options.sleep !== "function") {
    return createResultError(op, "private TLS trust sleep is invalid")
  }
  const clock = options.clock ?? Date.now
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  const deadline = clock() + waitR.data
  for (;;) {
    let failed: string | undefined
    for (const hostname of options.hostnames) {
      let probed: Awaited<ReturnType<ProjectPrivateTlsTrustProbe>>
      try {
        probed = await options.probe(hostname)
      } catch {
        failed = hostname
        break
      }
      if (typeof probed !== "object" || probed === null || probed.success !== true) {
        failed = hostname
        break
      }
      if (probed.data !== "trusted") {
        failed = hostname
        break
      }
    }
    if (failed === undefined) return createResult("trusted")
    if (clock() >= deadline) {
      return createResultError(
        op,
        `no trusted private TLS for "${failed}" after ${waitR.data}ms; refusing before serving`,
      )
    }
    await sleep(pollR.data)
  }
}

export type ProjectPrivateTlsGateState = {
  current(): ProjectPrivateTlsGateSnapshot
  update(snapshot: ProjectPrivateTlsGateSnapshot): void
}

function snapshotNormalize(snapshot: ProjectPrivateTlsGateSnapshot): ProjectPrivateTlsGateSnapshot {
  const list = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((entry): entry is string => typeof entry === "string"))].sort()
  }
  return {
    enrolled: list(snapshot?.enrolled),
    wildcardCovered: list(snapshot?.wildcardCovered),
    proven: list(snapshot?.proven),
  }
}

/**
 * The mutable cell shared by the TLS tracker (writer) and the private
 * regenerate hook (reader). Updates replace the whole snapshot, so
 * readers always see one consistent drain; reads return copies, so
 * readers cannot corrupt the published state. Starts empty: nothing is
 * proven, so the gate withholds every private route until the first
 * drain proves trust (fail-closed).
 */
export function projectPrivateTlsGateStateCreate(initial?: ProjectPrivateTlsGateSnapshot): ProjectPrivateTlsGateState {
  let stored = snapshotNormalize(initial ?? { enrolled: [], wildcardCovered: [], proven: [] })
  return {
    current(): ProjectPrivateTlsGateSnapshot {
      return {
        enrolled: [...stored.enrolled],
        wildcardCovered: [...stored.wildcardCovered],
        proven: [...stored.proven],
      }
    },
    update(snapshot: ProjectPrivateTlsGateSnapshot): void {
      stored = snapshotNormalize(snapshot)
    },
  }
}
