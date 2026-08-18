import { createResult, type Result } from "#result"

const cookieName = "__Host-project-registry-pre-auth"

export function zitadelPreAuthCookieClear(): Result<string> {
  return createResult(`${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
}
