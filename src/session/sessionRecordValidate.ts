import { createResult, createResultError, type Result } from "#result"
import { timeMillisecondsValidate } from "../runtime/timeMillisecondsValidate.js"
import type { SessionRecord } from "./SessionRecord.js"

const maximumSessionIdLength = 256
const maximumSubjectLength = 256
const maximumUsernameLength = 256
const maximumTokenReferenceIdLength = 256
const sessionRecordKeys = ["id", "subject", "username", "tokenReference", "createdAt", "expiresAt"]

export function sessionRecordValidate(value: unknown): Result<SessionRecord> {
  const op = "sessionRecordValidate"
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createResultError(op, "session record is invalid")
  }
  const session = value as Record<string, unknown>
  const keys = Object.keys(session)
  if (keys.length !== sessionRecordKeys.length || keys.some((key) => !sessionRecordKeys.includes(key))) {
    return createResultError(op, "session record is invalid")
  }
  if (
    typeof session.id !== "string" ||
    session.id.length === 0 ||
    session.id.length > maximumSessionIdLength ||
    typeof session.subject !== "string" ||
    session.subject.length === 0 ||
    session.subject.length > maximumSubjectLength ||
    typeof session.username !== "string" ||
    session.username.length === 0 ||
    session.username.length > maximumUsernameLength ||
    typeof session.tokenReference !== "string" ||
    session.tokenReference.length === 0 ||
    session.tokenReference.length > maximumTokenReferenceIdLength ||
    !timeMillisecondsValidate(session.createdAt) ||
    !timeMillisecondsValidate(session.expiresAt) ||
    session.expiresAt <= session.createdAt
  ) {
    return createResultError(op, "session record is invalid")
  }
  return createResult({
    id: session.id,
    subject: session.subject,
    username: session.username,
    tokenReference: session.tokenReference,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  })
}
