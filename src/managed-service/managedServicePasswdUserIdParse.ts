import { createResult, createResultError, type Result } from "#result"

/** Numeric uid of `user` from passwd(5) content; an error when absent or malformed. */
export function managedServicePasswdUserIdParse(passwd: string, user: string): Result<number> {
  const op = "managedServicePasswdUserIdParse"
  for (const line of passwd.split("\n")) {
    const fields = line.split(":")
    if (fields[0] !== user) continue
    const uid = fields[2]
    if (uid === undefined || !/^[0-9]+$/.test(uid))
      return createResultError(op, `passwd entry for ${user} is malformed`)
    return createResult(Number(uid))
  }
  return createResultError(op, `service user ${user} is not in passwd`)
}
