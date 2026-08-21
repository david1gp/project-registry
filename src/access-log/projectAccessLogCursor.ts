import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { createResult, type Result } from "#result"

const cursorVersion = 1
const defaultLifetimeMs = 15 * 60 * 1000
const maximumLifetimeMs = 24 * 60 * 60 * 1000
const maximumCursorLength = 4096

export type ProjectAccessLogCursorInput = {
  anchorDigest?: string
  offset?: number
  projectId: string
  source: string
  sourceFingerprint: string
  line: number
}

export type ProjectAccessLogCursorPayload = ProjectAccessLogCursorInput & {
  version: 1
  expiresAt: number
}

export type ProjectAccessLogCursorCodec = {
  encode(input: ProjectAccessLogCursorInput): Result<string>
  decode(value: unknown): Result<ProjectAccessLogCursorPayload>
}

type CursorBody = {
  a?: string
  e: number
  f: string
  l: number
  o?: number
  p: string
  s: string
  v: 1
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url")
}

function base64UrlDecode(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  try {
    return Buffer.from(value, "base64url")
  } catch {
    return undefined
  }
}

function cursorError(
  code: "access-log.invalid-input" | "access-log.invalid-cursor" | "access-log.cursor-expired",
  message: string,
) {
  return { success: false as const, op: "projectAccessLogCursor", code, errorMessage: message }
}

function inputIsValid(input: ProjectAccessLogCursorInput): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof input.projectId === "string" &&
    typeof input.source === "string" &&
    typeof input.sourceFingerprint === "string" &&
    (input.anchorDigest === undefined || /^[a-f0-9]{64}$/.test(input.anchorDigest)) &&
    (input.offset === undefined || (Number.isSafeInteger(input.offset) && input.offset >= 0)) &&
    /^[a-f0-9]{64}$/.test(input.projectId) &&
    /^(?:access\.jsonl|access-[A-Za-z0-9_.-]+\.jsonl(?:\.gz)?)$/.test(input.source) &&
    /^[A-Za-z0-9:._-]+$/.test(input.sourceFingerprint) &&
    input.sourceFingerprint.length > 0 &&
    input.sourceFingerprint.length <= 256 &&
    !input.sourceFingerprint.includes("\0") &&
    Number.isSafeInteger(input.line) &&
    input.line >= 0
  )
}

function bodyIsValid(value: unknown): value is CursorBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  const anchorIsValid = !Object.hasOwn(body, "a") || (typeof body.a === "string" && /^[a-f0-9]{64}$/.test(body.a))
  const offsetIsValid =
    !Object.hasOwn(body, "o") || (typeof body.o === "number" && Number.isSafeInteger(body.o) && body.o >= 0)
  const expectedKeyCount = 6 + (Object.hasOwn(body, "a") ? 1 : 0) + (Object.hasOwn(body, "o") ? 1 : 0)
  return (
    body.v === cursorVersion &&
    anchorIsValid &&
    offsetIsValid &&
    Number.isSafeInteger(body.e) &&
    typeof body.e === "number" &&
    body.e > 0 &&
    typeof body.f === "string" &&
    /^[A-Za-z0-9:._-]+$/.test(body.f) &&
    body.f.length > 0 &&
    body.f.length <= 256 &&
    typeof body.l === "number" &&
    Number.isSafeInteger(body.l) &&
    body.l >= 0 &&
    typeof body.p === "string" &&
    /^[a-f0-9]{64}$/.test(body.p) &&
    typeof body.s === "string" &&
    /^(?:access\.jsonl|access-[A-Za-z0-9_.-]+\.jsonl(?:\.gz)?)$/.test(body.s) &&
    Object.keys(body).length === expectedKeyCount
  )
}

export function projectAccessLogCursorCreate(
  options: { secret?: string | Uint8Array; clock?: () => number; lifetimeMs?: number } = {},
): ProjectAccessLogCursorCodec {
  const secret =
    typeof options.secret === "string" ? Buffer.from(options.secret, "utf8") : (options.secret ?? randomBytes(32))
  const clock = options.clock ?? Date.now
  const lifetimeMs = options.lifetimeMs ?? defaultLifetimeMs

  function signature(value: string): Buffer {
    return createHmac("sha256", secret).update(value, "utf8").digest()
  }

  return {
    encode(input) {
      if (!inputIsValid(input)) return cursorError("access-log.invalid-input", "access log cursor input is invalid")
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > maximumLifetimeMs) {
        return cursorError("access-log.invalid-input", "access log cursor lifetime is invalid")
      }
      let now: number
      try {
        now = clock()
      } catch {
        return cursorError("access-log.invalid-input", "access log cursor clock is invalid")
      }
      if (!Number.isSafeInteger(now) || now < 0)
        return cursorError("access-log.invalid-input", "access log cursor clock is invalid")
      const body: CursorBody = {
        v: cursorVersion,
        a: input.anchorDigest,
        e: now + lifetimeMs,
        p: input.projectId,
        s: input.source,
        f: input.sourceFingerprint,
        l: input.line,
        o: input.offset,
      }
      const encodedBody = base64UrlEncode(Buffer.from(JSON.stringify(body), "utf8"))
      const unsigned = `v${cursorVersion}.${encodedBody}`
      return createResult(`${unsigned}.${base64UrlEncode(signature(unsigned))}`)
    },
    decode(value) {
      if (typeof value !== "string" || value.length === 0 || value.length > maximumCursorLength) {
        return cursorError("access-log.invalid-cursor", "access log cursor is invalid")
      }
      const parts = value.split(".")
      if (parts.length !== 3 || parts[0] !== `v${cursorVersion}`) {
        return cursorError("access-log.invalid-cursor", "access log cursor is invalid")
      }
      const bodyPart = parts[1]
      const signaturePart = parts[2]
      if (bodyPart === undefined || signaturePart === undefined) {
        return cursorError("access-log.invalid-cursor", "access log cursor is invalid")
      }
      const bodyBytes = base64UrlDecode(bodyPart)
      const signatureBytes = base64UrlDecode(signaturePart)
      if (bodyBytes === undefined || signatureBytes === undefined || signatureBytes.length !== 32) {
        return cursorError("access-log.invalid-cursor", "access log cursor is invalid")
      }
      const unsigned = `${parts[0]}.${bodyPart}`
      const expectedSignature = signature(unsigned)
      if (expectedSignature.length !== signatureBytes.length || !timingSafeEqual(expectedSignature, signatureBytes)) {
        return cursorError("access-log.invalid-cursor", "access log cursor is invalid")
      }
      let body: unknown
      try {
        body = JSON.parse(bodyBytes.toString("utf8")) as unknown
      } catch {
        return cursorError("access-log.invalid-cursor", "access log cursor is invalid")
      }
      if (!bodyIsValid(body)) return cursorError("access-log.invalid-cursor", "access log cursor is invalid")
      let now: number
      try {
        now = clock()
      } catch {
        return cursorError("access-log.invalid-input", "access log cursor clock is invalid")
      }
      if (!Number.isSafeInteger(now) || now < 0)
        return cursorError("access-log.invalid-input", "access log cursor clock is invalid")
      if (now >= body.e) return cursorError("access-log.cursor-expired", "access log cursor has expired")
      return createResult({
        version: cursorVersion,
        expiresAt: body.e,
        ...(body.a === undefined ? {} : { anchorDigest: body.a }),
        ...(body.o === undefined ? {} : { offset: body.o }),
        projectId: body.p,
        source: body.s,
        sourceFingerprint: body.f,
        line: body.l,
      })
    },
  }
}
