import { describe, expect, test } from "bun:test"
import { createResult, createResultError } from "#result"
import { mutationOriginValidate } from "../web-server/mutationOriginValidate.js"
import { mutationSecurityValidate } from "../web-server/mutationSecurityValidate.js"
import { zitadelLoginTransactionStoreCreate } from "../zitadel/zitadelLoginTransactionStoreCreate.js"
import type { CsrfTokenStore } from "./CsrfTokenStore.js"
import { csrfTokenIssue } from "./csrfTokenIssue.js"
import { csrfTokenStoreCreate } from "./csrfTokenStoreCreate.js"
import { csrfTokenValidate } from "./csrfTokenValidate.js"
import { sessionActorResolve } from "./sessionActorResolve.js"
import { sessionCookieClear } from "./sessionCookieClear.js"
import { sessionCookieParse } from "./sessionCookieParse.js"
import { sessionCookieSerialize } from "./sessionCookieSerialize.js"
import { sessionLogout } from "./sessionLogout.js"
import { sessionRequestResolve } from "./sessionRequestResolve.js"
import { sessionStoreCreate } from "./sessionStoreCreate.js"
import { tokenReferenceStoreCreate } from "./tokenReferenceStoreCreate.js"

function fakeRandom(value: number) {
  return () => createResult(new Uint8Array(32).fill(value))
}

describe("session security", () => {
  test("stores opaque sessions without role snapshots and expires them", async () => {
    let now = 1_700_000_000_000
    const tokenReferences = tokenReferenceStoreCreate({ randomBytes: fakeRandom(1), clock: () => now })
    const tokenR = await tokenReferences.save({ accessToken: "access-token", expiresAt: now + 60_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const sessions = sessionStoreCreate({
      tokenReferences,
      randomBytes: fakeRandom(2),
      clock: () => now,
      maxAgeSeconds: 10,
    })
    const sessionR = await sessions.create({ subject: "subject", username: "alice", tokenReference: tokenR.data })
    expect(sessionR.success).toBe(true)
    if (!sessionR.success) return
    expect(sessionR.data).not.toHaveProperty("role")
    now += 10_001
    expect((await sessions.resolve(sessionR.data.id)).success).toBe(false)
    expect((await tokenReferences.resolve(tokenR.data)).success).toBe(false)
  })

  test("requires and enforces access-token reference expiry", async () => {
    let now = 1_700_000_000_000
    const tokenReferences = tokenReferenceStoreCreate({ clock: () => now, randomBytes: fakeRandom(7) })
    expect((await tokenReferences.save({ accessToken: "missing-expiry" } as never)).success).toBe(false)
    expect((await tokenReferences.save({ accessToken: "invalid-expiry", expiresAt: Number.NaN })).success).toBe(false)
    const tokenR = await tokenReferences.save({ accessToken: "access-token", expiresAt: now + 1_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    now += 1_001
    expect((await tokenReferences.resolve(tokenR.data)).success).toBe(false)
  })

  test("rejects malformed successful token-reference results", async () => {
    const tokenReferences = {
      async resolve() {
        return { success: true, data: { accessToken: "access-token" } }
      },
      async remove() {
        return createResult(true)
      },
    } as never
    const sessions = sessionStoreCreate({ tokenReferences, clock: () => 1_700_000_000_000 })
    expect(
      (await sessions.create({ subject: "subject", username: "alice", tokenReference: "reference" })).success,
    ).toBe(false)
  })

  test("does not let a session outlive its access-token reference", async () => {
    let now = 1_700_000_000_000
    const tokenReferences = tokenReferenceStoreCreate({ clock: () => now, randomBytes: fakeRandom(8) })
    const tokenR = await tokenReferences.save({ accessToken: "access-token", expiresAt: now + 5_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const sessions = sessionStoreCreate({
      tokenReferences,
      randomBytes: fakeRandom(9),
      clock: () => now,
      maxAgeSeconds: 60,
    })
    const sessionR = await sessions.create({ subject: "subject", username: "alice", tokenReference: tokenR.data })
    expect(sessionR.success).toBe(true)
    if (!sessionR.success) return
    expect(sessionR.data.expiresAt).toBe(now + 5_000)
    now += 5_001
    expect((await sessions.resolve(sessionR.data.id)).success).toBe(false)
  })

  test("serializes only secure host-scoped cookies", () => {
    const cookieR = sessionCookieSerialize("a".repeat(43), { maxAgeSeconds: 60 })
    expect(cookieR.success).toBe(true)
    if (!cookieR.success) return
    expect(cookieR.data).toContain("__Host-project-registry-session=")
    expect(cookieR.data).toContain("HttpOnly")
    expect(cookieR.data).toContain("Secure")
    expect(cookieR.data).toContain("SameSite=Lax")
    expect(cookieR.data).toContain("Path=/")
    expect(cookieR.data).not.toContain("Domain=")
    expect(sessionCookieParse(cookieR.data.split(";")[0])).toMatchObject({ success: true })
    expect(sessionCookieSerialize("a".repeat(43), { name: "session" }).success).toBe(false)
    expect(sessionCookieClear().success).toBe(true)
  })

  test("resolves the current role on every session access", async () => {
    const tokenReferences = tokenReferenceStoreCreate({ randomBytes: fakeRandom(11) })
    const tokenR = await tokenReferences.save({ accessToken: "access-token", expiresAt: Date.now() + 60_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const sessions = sessionStoreCreate({ tokenReferences, randomBytes: fakeRandom(12) })
    const sessionR = await sessions.create({ subject: "subject", username: "alice", tokenReference: tokenR.data })
    expect(sessionR.success).toBe(true)
    if (!sessionR.success) return
    let roles: readonly unknown[] = ["own"]
    const actorOptions = {
      sessions,
      tokenReferences,
      identityDirectory: {
        async usersList() {
          return createResult([])
        },
        async userRolesList() {
          return createResult(roles)
        },
        async userPreferredUsernameResolve() {
          return createResult("alice")
        },
      },
      posixUsers: { usernameExists: async () => createResult(true) },
    }
    const ownR = await sessionActorResolve(sessionR.data.id, actorOptions)
    expect(ownR.success && ownR.data.role).toBe("own")
    roles = ["admin", "own"]
    const adminR = await sessionActorResolve(sessionR.data.id, actorOptions)
    expect(adminR.success && adminR.data.role).toBe("admin")
    roles = ["operator"]
    expect((await sessionActorResolve(sessionR.data.id, actorOptions)).success).toBe(false)
  })

  test("rejects changed subject usernames and deleted POSIX accounts", async () => {
    let preferredUsername = "alice"
    let usernameExists = true
    const tokenReferences = tokenReferenceStoreCreate({ randomBytes: fakeRandom(13), clock: () => Date.now() })
    const tokenR = await tokenReferences.save({ accessToken: "access-token", expiresAt: Date.now() + 60_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const sessions = sessionStoreCreate({ tokenReferences, randomBytes: fakeRandom(14) })
    const sessionR = await sessions.create({ subject: "subject", username: "alice", tokenReference: tokenR.data })
    expect(sessionR.success).toBe(true)
    if (!sessionR.success) return
    const options = {
      sessions,
      tokenReferences,
      identityDirectory: {
        async usersList() {
          return createResult([])
        },
        async userRolesList() {
          return createResult(["own"])
        },
        async userPreferredUsernameResolve() {
          return createResult(preferredUsername)
        },
      },
      posixUsers: { usernameExists: async () => createResult(usernameExists) },
    }
    expect((await sessionActorResolve(sessionR.data.id, options)).success).toBe(true)
    preferredUsername = "bob"
    expect(await sessionActorResolve(sessionR.data.id, options)).toMatchObject({
      success: false,
      errorMessage: "session user mapping is unavailable",
      hint: "Sign in again, then retry. If the problem persists, ask an administrator to verify your account mapping.",
    })
    preferredUsername = "alice"
    usernameExists = false
    expect(await sessionActorResolve(sessionR.data.id, options)).toMatchObject({
      success: false,
      errorMessage: "session user mapping is unavailable",
      hint: "Sign in again, then retry. If the problem persists, ask an administrator to verify your account mapping.",
    })
  })

  test("rechecks token and session expiry after identity and role lookups", async () => {
    let now = 1_700_000_000_000
    const tokenReferences = tokenReferenceStoreCreate({ clock: () => now, randomBytes: fakeRandom(24) })
    const tokenR = await tokenReferences.save({ accessToken: "access-token", expiresAt: now + 1_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const sessions = sessionStoreCreate({
      tokenReferences,
      randomBytes: fakeRandom(25),
      clock: () => now,
      maxAgeSeconds: 60,
    })
    const sessionR = await sessions.create({ subject: "subject", username: "alice", tokenReference: tokenR.data })
    expect(sessionR.success).toBe(true)
    if (!sessionR.success) return
    let expireAfterIdentity = true
    const options = {
      sessions,
      tokenReferences,
      identityDirectory: {
        async usersList() {
          return createResult([])
        },
        async userRolesList() {
          now += 1_001
          return createResult(["own"])
        },
        async userPreferredUsernameResolve() {
          if (expireAfterIdentity) now += 1_001
          return createResult("alice")
        },
      },
      posixUsers: { usernameExists: async () => createResult(true) },
      clock: () => now,
    }
    expect((await sessionActorResolve(sessionR.data.id, options)).success).toBe(false)
    now = 1_700_000_000_000
    expireAfterIdentity = false
    expect((await sessionActorResolve(sessionR.data.id, options)).success).toBe(false)
  })

  test("rejects interleaved session and token changes after role resolution", async () => {
    const now = 1_700_000_000_000
    const session = {
      id: "s".repeat(43),
      subject: "subject",
      username: "alice",
      tokenReference: "reference",
      createdAt: now,
      expiresAt: now + 60_000,
    }
    const tokens = { accessToken: "access-token", expiresAt: now + 60_000 }
    let tokenResolves = 0
    let revoked = false
    const options = {
      sessions: {
        async resolve() {
          return revoked ? createResultError("session", "revoked") : createResult(session)
        },
      },
      tokenReferences: {
        async resolve() {
          tokenResolves += 1
          if (tokenResolves === 2) revoked = true
          return createResult(tokens)
        },
      },
      identityDirectory: {
        async usersList() {
          return createResult([])
        },
        async userRolesList() {
          return createResult(["own"])
        },
        async userPreferredUsernameResolve() {
          return createResult("alice")
        },
      },
      posixUsers: { usernameExists: async () => createResult(true) },
      clock: () => now,
    }
    expect((await sessionActorResolve(session.id, options as never)).success).toBe(false)
  })

  test("rejects oversized identity IDs and malformed session dependency envelopes", async () => {
    const now = 1_700_000_000_000
    const tokenReferences = tokenReferenceStoreCreate({ clock: () => now, randomBytes: fakeRandom(27) })
    const tokenR = await tokenReferences.save({ accessToken: "access-token", expiresAt: now + 60_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const sessions = sessionStoreCreate({ tokenReferences, clock: () => now, randomBytes: fakeRandom(28) })
    expect(
      (await sessions.create({ subject: "s".repeat(257), username: "alice", tokenReference: tokenR.data })).success,
    ).toBe(false)
    expect(
      (await sessions.create({ subject: "subject", username: "u".repeat(257), tokenReference: tokenR.data })).success,
    ).toBe(false)
    expect(
      (await sessions.create({ subject: "subject", username: "alice", tokenReference: "r".repeat(257) })).success,
    ).toBe(false)
    expect((await sessions.resolve("s".repeat(257))).success).toBe(false)
    expect((await tokenReferences.resolve("r".repeat(257))).success).toBe(false)

    const cookieR = sessionCookieSerialize("a".repeat(43))
    expect(cookieR.success).toBe(true)
    if (!cookieR.success) return
    const malformedSessions = {
      async resolve() {
        return createResult({ id: "s".repeat(43), subject: "subject" })
      },
    }
    expect(await sessionRequestResolve(cookieR.data, malformedSessions as never)).toMatchObject({
      success: false,
      errorMessage: "session is unavailable",
      hint: "Sign in again, then retry. If the problem persists, contact an administrator.",
    })
    expect(
      (
        await sessionActorResolve("s".repeat(43), {
          sessions: malformedSessions as never,
          tokenReferences: {
            resolve: async () => createResult({ accessToken: "access-token", expiresAt: now + 60_000 }),
          } as never,
          identityDirectory: {
            async usersList() {
              return createResult([])
            },
            async userRolesList() {
              return createResult(["own"])
            },
            async userPreferredUsernameResolve() {
              return createResult("alice")
            },
          },
          posixUsers: { usernameExists: async () => createResult(true) },
          clock: () => now,
        })
      ).success,
    ).toBe(false)
  })

  test("does not insert a session after cancellation while its token reference resolves", async () => {
    const now = 1_700_000_000_000
    let release: ((value: ReturnType<typeof createResult>) => void) | undefined
    const tokenReferences = {
      async resolve() {
        return await new Promise((resolve) => {
          release = resolve as (value: ReturnType<typeof createResult>) => void
        })
      },
    }
    const sessions = sessionStoreCreate({ tokenReferences: tokenReferences as never, clock: () => now })
    const controller = new AbortController()
    const createR = sessions.create(
      { subject: "subject", username: "alice", tokenReference: "reference" },
      { signal: controller.signal },
    )
    await Promise.resolve()
    controller.abort()
    release?.(createResult({ accessToken: "access-token", expiresAt: now + 60_000 }))
    expect((await createR).success).toBe(false)
  })

  test("issues session-bound CSRF tokens and rejects replay across sessions and expiry", async () => {
    let now = 1_700_000_000_000
    const csrf = csrfTokenStoreCreate({ clock: () => now, randomBytes: fakeRandom(3), maxAgeSeconds: 10 })
    const tokenR = await csrfTokenIssue("session-a", csrf)
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    expect((await csrfTokenValidate("session-a", tokenR.data, csrf)).success).toBe(true)
    expect((await csrfTokenValidate("session-b", tokenR.data, csrf)).success).toBe(false)
    now += 10_001
    expect((await csrfTokenValidate("session-a", tokenR.data, csrf)).success).toBe(false)
  })

  test("bounds stores and cleans expired entries before inserts", async () => {
    let now = 1_700_000_000_000
    const tokenReferences = tokenReferenceStoreCreate({
      clock: () => now,
      randomBytes: fakeRandom(15),
      maxEntries: 1,
    })
    const expiredTokenR = await tokenReferences.save({ accessToken: "expired", expiresAt: now + 1_000 })
    expect(expiredTokenR.success).toBe(true)
    expect((await tokenReferences.save({ accessToken: "full", expiresAt: now + 2_000 })).success).toBe(false)
    now += 1_001
    const tokenR = await tokenReferences.save({ accessToken: "fresh", expiresAt: now + 2_000 })
    expect(tokenR.success).toBe(true)

    const csrf = csrfTokenStoreCreate({
      clock: () => now,
      randomBytes: fakeRandom(16),
      maxAgeSeconds: 1,
      maxEntries: 1,
    })
    const csrfR = await csrf.issue("session-a")
    expect(csrfR.success).toBe(true)
    expect((await csrf.issue("session-b")).success).toBe(false)
    now += 1_001
    expect((await csrf.issue("session-b")).success).toBe(true)

    let sessionTokenSeed = 17
    const sessionTokenReferences = tokenReferenceStoreCreate({
      clock: () => now,
      randomBytes: () => createResult(new Uint8Array(32).fill(sessionTokenSeed++)),
      maxEntries: 2,
    })
    const sessions = sessionStoreCreate({
      tokenReferences: sessionTokenReferences,
      randomBytes: fakeRandom(18),
      clock: () => now,
      maxAgeSeconds: 1,
      maxEntries: 1,
    })
    const firstTokenR = await sessionTokenReferences.save({ accessToken: "session-a", expiresAt: now + 10_000 })
    expect(firstTokenR.success).toBe(true)
    if (!firstTokenR.success) return
    const firstSessionR = await sessions.create({
      subject: "subject-a",
      username: "alice",
      tokenReference: firstTokenR.data,
    })
    expect(firstSessionR.success).toBe(true)
    now += 1_001
    const secondTokenR = await sessionTokenReferences.save({ accessToken: "session-b", expiresAt: now + 10_000 })
    expect(secondTokenR.success).toBe(true)
    if (!secondTokenR.success) return
    const secondSessionR = await sessions.create({
      subject: "subject-b",
      username: "bob",
      tokenReference: secondTokenR.data,
    })
    expect(secondSessionR.success).toBe(true)

    const loginTransactions = zitadelLoginTransactionStoreCreate({ clock: () => now, maxEntries: 1 })
    const transaction = {
      state: "a".repeat(43),
      nonce: "b".repeat(43),
      codeVerifier: "c".repeat(43),
      callbackUrl: "https://registry.example/callback",
      preAuthCookieHash: "d".repeat(64),
      expiresAt: now + 1_000,
    }
    expect((await loginTransactions.put(transaction)).success).toBe(true)
    expect((await loginTransactions.put({ ...transaction, state: "e".repeat(43) })).success).toBe(false)
    now += 1_001
    expect(
      (await loginTransactions.put({ ...transaction, state: "e".repeat(43), expiresAt: now + 1_000 })).success,
    ).toBe(true)
  })

  test("rejects invalid capacities and serializes CSRF validation after its hash", async () => {
    const now = 1_700_000_000_000
    const tokenReferences = tokenReferenceStoreCreate({ clock: () => now, maxEntries: 0 })
    expect((await tokenReferences.save({ accessToken: "access", expiresAt: now + 1_000 })).success).toBe(false)
    const csrf = csrfTokenStoreCreate({ clock: () => now, randomBytes: fakeRandom(19), maxEntries: 1 })
    const tokenR = await csrf.issue("session-a")
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const validation = csrf.validate("session-a", tokenR.data)
    await csrf.revoke("session-a")
    expect((await validation).success).toBe(false)
  })

  test("requires the exact configured origin before CSRF validation", async () => {
    const csrf = csrfTokenStoreCreate({ randomBytes: fakeRandom(4) })
    const tokenR = await csrfTokenIssue("session-a", csrf)
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    expect(mutationOriginValidate("https://registry.example", "https://registry.example").success).toBe(true)
    expect(mutationOriginValidate("http://registry.example", "http://registry.example").success).toBe(false)
    expect(mutationOriginValidate("https://registry.example.evil", "https://registry.example").success).toBe(false)
    expect(mutationOriginValidate(undefined, "https://registry.example").success).toBe(false)
    expect(
      (
        await mutationSecurityValidate({
          origin: "https://registry.example",
          expectedOrigin: "https://registry.example",
          sessionId: "session-a",
          csrfToken: tokenR.data,
          csrf,
        })
      ).success,
    ).toBe(true)
    expect(
      (
        await mutationSecurityValidate({
          origin: "https://other.example",
          expectedOrigin: "https://registry.example",
          sessionId: "session-a",
          csrfToken: tokenR.data,
          csrf,
        })
      ).success,
    ).toBe(false)
  })

  test("requires exact successful CSRF result data", async () => {
    const malformedCsrf: CsrfTokenStore = {
      async issue() {
        return createResult("csrf")
      },
      async validate() {
        return createResult("true" as never)
      },
      async revoke() {
        return createResult(true)
      },
    }
    expect(
      (
        await mutationSecurityValidate({
          origin: "https://registry.example",
          expectedOrigin: "https://registry.example",
          sessionId: "session-a",
          csrfToken: "csrf",
          csrf: malformedCsrf,
        })
      ).success,
    ).toBe(false)
    expect((await csrfTokenValidate("session-a", "csrf", malformedCsrf)).success).toBe(false)
  })

  test("logout revokes the session and clears the cookie", async () => {
    const tokenReferences = tokenReferenceStoreCreate({ randomBytes: fakeRandom(5) })
    const tokenR = await tokenReferences.save({ accessToken: "access-token", expiresAt: Date.now() + 60_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const sessions = sessionStoreCreate({ tokenReferences, randomBytes: fakeRandom(6) })
    const sessionR = await sessions.create({ subject: "subject", username: "alice", tokenReference: tokenR.data })
    expect(sessionR.success).toBe(true)
    if (!sessionR.success) return
    const cookieR = sessionCookieSerialize(sessionR.data.id)
    expect(cookieR.success).toBe(true)
    if (!cookieR.success) return
    expect((await sessionLogout(cookieR.data, sessions)).success).toBe(false)
    expect((await sessions.resolve(sessionR.data.id)).success).toBe(true)
    const csrf = csrfTokenStoreCreate({ randomBytes: fakeRandom(22) })
    const csrfR = await csrf.issue(sessionR.data.id)
    expect(csrfR.success).toBe(true)
    if (!csrfR.success) return
    const logoutR = await sessionLogout(cookieR.data, sessions, { csrf, csrfToken: csrfR.data })
    expect(logoutR.success).toBe(true)
    expect((await sessions.resolve(sessionR.data.id)).success).toBe(false)
    expect(logoutR.success && logoutR.data.setCookie).toContain("Max-Age=0")
    expect(logoutR.success && logoutR.data.status).toBe("revoked")
  })

  test("bounds session cookie and CSRF inputs", async () => {
    expect(sessionCookieParse("x".repeat(8_193)).success).toBe(false)
    const csrf = csrfTokenStoreCreate({ randomBytes: fakeRandom(26) })
    expect((await csrf.validate("session-a", "x".repeat(257))).success).toBe(false)
    expect((await csrf.revoke("s".repeat(257))).success).toBe(false)
  })

  test("logout clears the cookie and reports degradation when cleanup fails", async () => {
    const tokenReferences = tokenReferenceStoreCreate({ randomBytes: fakeRandom(20) })
    const tokenR = await tokenReferences.save({ accessToken: "access-token", expiresAt: Date.now() + 60_000 })
    expect(tokenR.success).toBe(true)
    if (!tokenR.success) return
    const sessions = sessionStoreCreate({ tokenReferences, randomBytes: fakeRandom(21) })
    const sessionR = await sessions.create({ subject: "subject", username: "alice", tokenReference: tokenR.data })
    expect(sessionR.success).toBe(true)
    if (!sessionR.success) return
    const cookieR = sessionCookieSerialize(sessionR.data.id)
    expect(cookieR.success).toBe(true)
    if (!cookieR.success) return
    const failingSessions = {
      ...sessions,
      async revoke() {
        return createResultError("test", "revoke failed")
      },
    }
    const csrf = csrfTokenStoreCreate({ randomBytes: fakeRandom(23) })
    const csrfR = await csrf.issue(sessionR.data.id)
    expect(csrfR.success).toBe(true)
    if (!csrfR.success) return
    const failingCsrf: CsrfTokenStore = {
      issue: csrf.issue,
      validate: csrf.validate,
      async revoke() {
        return createResultError("test", "revoke failed")
      },
    }
    const logoutR = await sessionLogout(cookieR.data, failingSessions, {
      csrf: failingCsrf,
      csrfToken: csrfR.data,
      tokenReferences,
    })
    expect(logoutR.success).toBe(true)
    if (!logoutR.success) return
    expect(logoutR.data.status).toBe("degraded")
    expect(logoutR.data.setCookie).toContain("Max-Age=0")
    expect((await tokenReferences.resolve(tokenR.data)).success).toBe(false)
  })
})
