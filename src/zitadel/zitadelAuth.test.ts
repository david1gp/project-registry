import { describe, expect, test } from "bun:test"
import { createResult } from "#result"
import type { IdentityDirectory } from "../identity/IdentityDirectory.js"
import type { RandomBytes } from "../session/RandomBytes.js"
import { sessionStoreCreate } from "../session/sessionStoreCreate.js"
import { tokenReferenceStoreCreate } from "../session/tokenReferenceStoreCreate.js"
import type { ZitadelJwk } from "./ZitadelJwk.js"
import type { ZitadelOidcConfig } from "./ZitadelOidcConfig.js"
import { zitadelCallbackHandle } from "./zitadelCallbackHandle.js"
import { zitadelConfigValidate } from "./zitadelConfigValidate.js"
import { zitadelDiscoveryFetch } from "./zitadelDiscoveryFetch.js"
import { zitadelIdTokenValidate } from "./zitadelIdTokenValidate.js"
import { zitadelJwksFetch } from "./zitadelJwksFetch.js"
import { zitadelLoginStart } from "./zitadelLoginStart.js"
import { zitadelLoginTransactionStoreCreate } from "./zitadelLoginTransactionStoreCreate.js"
import { zitadelPreAuthCookieParse } from "./zitadelPreAuthCookieParse.js"
import { zitadelTokenExchange } from "./zitadelTokenExchange.js"

const now = 1_700_000_000_000
const config: ZitadelOidcConfig = {
  issuer: "https://zitadel.example",
  clientId: "registry-client",
  clientSecret: "client-secret",
  callbackUrl: "https://registry.example/login/zitadel/callback",
  clockSkewSeconds: 0,
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function nonCanonicalBase64UrlVariant(value: string): string | undefined {
  const remainder = value.length % 4
  if (remainder !== 2 && remainder !== 3) return undefined
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const last = value.at(-1)
  if (last === undefined) return undefined
  const index = alphabet.indexOf(last)
  if (index < 0) return undefined
  const unusedBits = remainder === 2 ? 4 : 2
  const variant = (index & ~((1 << unusedBits) - 1)) | 1
  return `${value.slice(0, -1)}${alphabet[variant]}`
}

function jsonBase64Url(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
}

async function keyPairCreate(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
}

async function tokenCreate(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const header = jsonBase64Url({ alg: "RS256", kid: "key-1", typ: "JWT" })
  const payload = jsonBase64Url(claims)
  const input = new TextEncoder().encode(`${header}.${payload}`)
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, input)
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`
}

function fakeRandom(seed: number): RandomBytes {
  let next = seed
  return () => {
    const value = new Uint8Array(32).fill(next)
    next += 1
    return createResult(value)
  }
}

function identityDirectory(): IdentityDirectory {
  return {
    async usersList() {
      return createResult([{ subject: "subject-1", preferredUsername: "alice" }])
    },
    async userRolesList() {
      return createResult(["own", "admin"])
    },
    async userPreferredUsernameResolve() {
      return createResult("alice")
    },
  }
}

describe("Zitadel browser identity", () => {
  test("starts authorization code PKCE and completes a validated callback", async () => {
    const pair = await keyPairCreate()
    const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as ZitadelJwk
    publicJwk.kid = "key-1"
    publicJwk.alg = "RS256"
    const transactions = zitadelLoginTransactionStoreCreate({ clock: () => now })
    let discoveryCalls = 0
    let tokenVerifier = ""
    const http = async (input: string, _init: RequestInit): Promise<Response> => {
      if (input === `${config.issuer}/.well-known/openid-configuration`) {
        discoveryCalls += 1
        return new Response(
          JSON.stringify({
            issuer: config.issuer,
            authorization_endpoint: "https://zitadel.example/oauth/authorize",
            token_endpoint: "https://zitadel.example/oauth/token",
            jwks_uri: "https://zitadel.example/oauth/keys",
          }),
          { status: 200 },
        )
      }
      if (input === "https://zitadel.example/oauth/token") {
        return new Response(null, { status: 500 })
      }
      if (input === "https://zitadel.example/oauth/keys") {
        return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })
      }
      return new Response(null, { status: 404 })
    }
    const startR = await zitadelLoginStart({ config, http, transactions, clock: () => now, randomBytes: fakeRandom(1) })
    expect(startR.success).toBe(true)
    if (!startR.success) return
    const authorizationUrl = new URL(startR.data.authorizationUrl)
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorizationUrl.searchParams.get("state")).toBe(startR.data.state)
    const nonce = authorizationUrl.searchParams.get("nonce") ?? ""
    const tokenReferences = tokenReferenceStoreCreate({ randomBytes: fakeRandom(4), clock: () => now })
    const sessions = sessionStoreCreate({ tokenReferences, randomBytes: fakeRandom(5), clock: () => now })
    const callbackR = await zitadelCallbackHandle({
      config,
      callbackUrl: config.callbackUrl,
      query: new URLSearchParams({ state: startR.data.state, code: "authorization-code" }),
      cookieHeader: startR.data.setCookie.split(";", 1)[0],
      http: async (input, init) => {
        if (input === "https://zitadel.example/oauth/token") {
          tokenVerifier = new URLSearchParams(String(init.body)).get("code_verifier") ?? ""
          return new Response(
            JSON.stringify({
              access_token: "access-token",
              id_token: await tokenCreate(pair.privateKey, {
                iss: config.issuer,
                aud: config.clientId,
                sub: "subject-1",
                preferred_username: "alice",
                nonce,
                iat: now / 1000,
                exp: now / 1000 + 300,
              }),
            }),
            { status: 200 },
          )
        }
        if (input === "https://zitadel.example/oauth/keys")
          return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })
        return http(input, init)
      },
      transactions,
      posixUsers: { usernameExists: async (username) => createResult(username === "alice") },
      identityDirectory: identityDirectory(),
      tokenReferences,
      sessions,
      clock: () => now,
    })
    expect(callbackR.success).toBe(true)
    expect(discoveryCalls).toBe(2)
    expect(tokenVerifier.length).toBeGreaterThanOrEqual(43)
    const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenVerifier))
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(base64UrlEncode(new Uint8Array(challenge)))
    if (!callbackR.success) return
    expect(callbackR.data.setCookie).toContain("HttpOnly")
    expect(callbackR.data.clearPreAuthCookie).toContain("__Host-project-registry-pre-auth=")
    expect(callbackR.data.clearPreAuthCookie).toContain("Max-Age=0")
    expect(callbackR.data.username).toBe("alice")
    const replayR = await zitadelCallbackHandle({
      config,
      callbackUrl: config.callbackUrl,
      query: new URLSearchParams({ state: startR.data.state, code: "authorization-code" }),
      cookieHeader: startR.data.setCookie.split(";", 1)[0],
      http,
      transactions,
      posixUsers: { usernameExists: async (username) => createResult(username === "alice") },
      identityDirectory: identityDirectory(),
      tokenReferences,
      sessions,
      clock: () => now,
    })
    expect(replayR.success).toBe(false)
    expect(replayR.success || replayR.errorData).toContain("__Host-project-registry-pre-auth=")
  })

  test("rejects login CSRF and browser swaps before contacting the provider", async () => {
    const transactions = zitadelLoginTransactionStoreCreate({ clock: () => now })
    const discovery = async () =>
      new Response(
        JSON.stringify({
          issuer: config.issuer,
          authorization_endpoint: "https://zitadel.example/authorize",
          token_endpoint: "https://zitadel.example/token",
          jwks_uri: "https://zitadel.example/keys",
        }),
        { status: 200 },
      )
    const startAR = await zitadelLoginStart({
      config,
      http: discovery,
      transactions,
      clock: () => now,
      randomBytes: fakeRandom(20),
    })
    const startBR = await zitadelLoginStart({
      config,
      http: discovery,
      transactions,
      clock: () => now,
      randomBytes: fakeRandom(30),
    })
    expect(startAR.success).toBe(true)
    expect(startBR.success).toBe(true)
    if (!startAR.success || !startBR.success) return
    let providerCalls = 0
    const callbackOptions = {
      config,
      callbackUrl: config.callbackUrl,
      query: new URLSearchParams({ state: startAR.data.state, code: "attacker-code" }),
      cookieHeader: startBR.data.setCookie.split(";", 1)[0],
      http: async () => {
        providerCalls += 1
        return new Response(null, { status: 500 })
      },
      transactions,
      posixUsers: { usernameExists: async () => createResult(true) },
      identityDirectory: identityDirectory(),
      tokenReferences: tokenReferenceStoreCreate({ randomBytes: fakeRandom(40), clock: () => now }),
      sessions: sessionStoreCreate({
        tokenReferences: tokenReferenceStoreCreate({ randomBytes: fakeRandom(41), clock: () => now }),
        randomBytes: fakeRandom(42),
        clock: () => now,
      }),
      clock: () => now,
    }
    const swapR = await zitadelCallbackHandle(callbackOptions)
    expect(swapR.success).toBe(false)
    expect(providerCalls).toBe(0)
    expect(swapR.success || swapR.errorData).toContain("Max-Age=0")
    const replayR = await zitadelCallbackHandle({
      ...callbackOptions,
      cookieHeader: startAR.data.setCookie.split(";", 1)[0],
    })
    expect(replayR.success).toBe(false)
    expect(providerCalls).toBe(0)
  })

  test("revokes a session that resolves after callback timeout", async () => {
    const pair = await keyPairCreate()
    const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as ZitadelJwk
    publicJwk.kid = "key-1"
    publicJwk.alg = "RS256"
    const transactions = zitadelLoginTransactionStoreCreate({ clock: () => now })
    const discoveryBody = JSON.stringify({
      issuer: config.issuer,
      authorization_endpoint: "https://zitadel.example/oauth/authorize",
      token_endpoint: "https://zitadel.example/oauth/token",
      jwks_uri: "https://zitadel.example/oauth/keys",
    })
    const startR = await zitadelLoginStart({
      config,
      http: async () => new Response(discoveryBody),
      transactions,
      clock: () => now,
      randomBytes: fakeRandom(43),
    })
    expect(startR.success).toBe(true)
    if (!startR.success) return
    const authorizationUrl = new URL(startR.data.authorizationUrl)
    const nonce = authorizationUrl.searchParams.get("nonce") ?? ""
    const tokenReferences = tokenReferenceStoreCreate({ clock: () => now, randomBytes: fakeRandom(44) })
    let sessionTokenReference = ""
    let releaseLateSession: ((value: unknown) => void) | undefined
    let revokeCalls = 0
    const sessions = {
      async create(input: { tokenReference: string }) {
        sessionTokenReference = input.tokenReference
        return await new Promise<unknown>((resolve) => {
          releaseLateSession = resolve
        })
      },
      async revoke() {
        revokeCalls += 1
        return createResult(true)
      },
    }
    const callbackRPromise = zitadelCallbackHandle({
      config,
      callbackUrl: config.callbackUrl,
      query: new URLSearchParams({ state: startR.data.state, code: "authorization-code" }),
      cookieHeader: startR.data.setCookie.split(";", 1)[0],
      http: async (input) => {
        if (input === "https://zitadel.example/oauth/token") {
          return new Response(
            JSON.stringify({
              access_token: "access-token",
              id_token: await tokenCreate(pair.privateKey, {
                iss: config.issuer,
                aud: config.clientId,
                sub: "subject-1",
                preferred_username: "alice",
                nonce,
                iat: now / 1000,
                exp: now / 1000 + 300,
              }),
            }),
            { status: 200 },
          )
        }
        if (input === "https://zitadel.example/oauth/keys")
          return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })
        return new Response(discoveryBody, { status: 200 })
      },
      transactions,
      posixUsers: { usernameExists: async () => createResult(true) },
      identityDirectory: identityDirectory(),
      tokenReferences,
      sessions: sessions as never,
      clock: () => now,
      timeoutMs: 5,
    })
    const callbackR = await callbackRPromise
    expect(callbackR.success).toBe(false)
    expect(releaseLateSession).toBeDefined()
    if (releaseLateSession === undefined) return
    releaseLateSession(
      createResult({
        id: "s".repeat(43),
        subject: "subject-1",
        username: "alice",
        tokenReference: sessionTokenReference,
        createdAt: now,
        expiresAt: now + 60_000,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(revokeCalls).toBe(1)
    expect((await tokenReferences.resolve(sessionTokenReference)).success).toBe(false)
  })

  test("rejects HTTP issuer, callback, discovery, JWKS, and token endpoints", async () => {
    expect(zitadelConfigValidate({ ...config, issuer: "http://zitadel.example" }).success).toBe(false)
    expect(
      zitadelConfigValidate({ ...config, callbackUrl: "http://registry.example/login/zitadel/callback" }).success,
    ).toBe(false)
    const httpDiscoveryR = await zitadelDiscoveryFetch(
      config,
      async () =>
        new Response(
          JSON.stringify({
            issuer: config.issuer,
            authorization_endpoint: "http://zitadel.example/authorize",
            token_endpoint: "https://zitadel.example/token",
            jwks_uri: "https://zitadel.example/keys",
          }),
          { status: 200 },
        ),
    )
    expect(httpDiscoveryR.success).toBe(false)
    expect((await zitadelJwksFetch("http://zitadel.example/keys", async () => new Response(null))).success).toBe(false)
    const httpTokenR = await zitadelTokenExchange({
      config,
      discovery: {
        issuer: config.issuer,
        authorizationEndpoint: "https://zitadel.example/authorize",
        tokenEndpoint: "http://zitadel.example/token",
        jwksUri: "https://zitadel.example/keys",
      },
      http: async () => new Response(null, { status: 500 }),
      code: "code",
      codeVerifier: "a".repeat(43),
    })
    expect(httpTokenR.success).toBe(false)
  })

  test("bounds provider waits, cancellation, response bodies, and random values", async () => {
    const discoveryBody = JSON.stringify({
      issuer: config.issuer,
      authorization_endpoint: "https://zitadel.example/authorize",
      token_endpoint: "https://zitadel.example/token",
      jwks_uri: "https://zitadel.example/keys",
    })
    const never = async () => await new Promise<Response>(() => undefined)
    expect((await zitadelDiscoveryFetch(config, never, { timeoutMs: 5 })).success).toBe(false)

    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    const abortResult = zitadelDiscoveryFetch(
      config,
      async (_input, init) => {
        requestSignal = init.signal
        return await new Promise<Response>(() => undefined)
      },
      { timeoutMs: 1_000, signal: controller.signal },
    )
    controller.abort()
    expect((await abortResult).success).toBe(false)
    expect(requestSignal?.aborted).toBe(true)

    const oversized = await zitadelDiscoveryFetch(
      config,
      async () => new Response(discoveryBody, { headers: { "content-length": String(discoveryBody.length) } }),
      { maxBodyBytes: 16 },
    )
    expect(oversized.success).toBe(false)

    const transactions = zitadelLoginTransactionStoreCreate({ clock: () => now })
    const malformedRandom = await zitadelLoginStart({
      config,
      http: async () => new Response(discoveryBody),
      transactions,
      clock: () => now,
      randomBytes: () => createResult(new Array(32) as never),
    })
    expect(malformedRandom.success).toBe(false)
    expect(zitadelPreAuthCookieParse(`__Host-project-registry-pre-auth=${"a".repeat(8_193)}`).success).toBe(false)
  })

  test("rejects token expiry arithmetic overflow and invalid clocks", async () => {
    const tokenResponse = async (expiresIn: unknown) =>
      new Response(JSON.stringify({ access_token: "access-token", id_token: "id-token", expires_in: expiresIn }))
    const discovery = {
      issuer: config.issuer,
      authorizationEndpoint: "https://zitadel.example/authorize",
      tokenEndpoint: "https://zitadel.example/token",
      jwksUri: "https://zitadel.example/keys",
    }
    const overflowR = await zitadelTokenExchange({
      config,
      discovery,
      http: async () => tokenResponse(Number.MAX_SAFE_INTEGER),
      code: "code",
      codeVerifier: "a".repeat(43),
      clock: () => now,
    })
    expect(overflowR.success).toBe(false)
    const invalidClockR = await zitadelTokenExchange({
      config,
      discovery,
      http: async () => tokenResponse(60),
      code: "code",
      codeVerifier: "a".repeat(43),
      clock: () => Number.NaN,
    })
    expect(invalidClockR.success).toBe(false)
    expect((await zitadelIdTokenValidate("a".repeat(32_769), config, "nonce", { keys: [] }, () => now)).success).toBe(
      false,
    )
  })

  test("rejects duplicate and malformed JWKS key IDs and non-canonical key material", async () => {
    const pair = await keyPairCreate()
    const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as ZitadelJwk
    publicJwk.kid = "key-1"
    publicJwk.alg = "RS256"
    expect(
      (
        await zitadelJwksFetch(
          "https://zitadel.example/keys",
          async () =>
            new Response(JSON.stringify({ keys: [publicJwk, { ...publicJwk, alg: "PS256" }] }), { status: 200 }),
        )
      ).success,
    ).toBe(false)
    expect(
      (
        await zitadelJwksFetch(
          "https://zitadel.example/keys",
          async () => new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: "bad key" }] }), { status: 200 }),
        )
      ).success,
    ).toBe(false)
    const nonCanonicalModulus = nonCanonicalBase64UrlVariant(publicJwk.n ?? "")
    expect(nonCanonicalModulus).toBeDefined()
    expect(
      (
        await zitadelJwksFetch(
          "https://zitadel.example/keys",
          async () =>
            new Response(JSON.stringify({ keys: [{ ...publicJwk, n: nonCanonicalModulus }] }), { status: 200 }),
        )
      ).success,
    ).toBe(false)
  })

  test("rejects replayed state before contacting the provider", async () => {
    const transactions = zitadelLoginTransactionStoreCreate({ clock: () => now })
    const startR = await zitadelLoginStart({
      config,
      http: async () =>
        new Response(
          JSON.stringify({
            issuer: config.issuer,
            authorization_endpoint: "https://zitadel.example/authorize",
            token_endpoint: "https://zitadel.example/token",
            jwks_uri: "https://zitadel.example/keys",
          }),
          { status: 200 },
        ),
      transactions,
      clock: () => now,
      randomBytes: fakeRandom(7),
    })
    expect(startR.success).toBe(true)
    if (!startR.success) return
    const callback = {
      config,
      callbackUrl: config.callbackUrl,
      query: new URLSearchParams({ state: `${startR.data.state}-wrong`, code: "code" }),
      cookieHeader: startR.data.setCookie.split(";", 1)[0],
      http: async () => new Response(null, { status: 500 }),
      transactions,
      posixUsers: { usernameExists: async () => createResult(true) },
      identityDirectory: identityDirectory(),
      tokenReferences: tokenReferenceStoreCreate({ randomBytes: fakeRandom(8) }),
      sessions: sessionStoreCreate({
        tokenReferences: tokenReferenceStoreCreate({ randomBytes: fakeRandom(9) }),
        randomBytes: fakeRandom(10),
      }),
      clock: () => now,
    }
    expect((await zitadelCallbackHandle(callback)).success).toBe(false)
  })

  test("rejects nonce, issuer, audience, signature, and time claim failures", async () => {
    const pair = await keyPairCreate()
    const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as ZitadelJwk
    publicJwk.kid = "key-1"
    publicJwk.alg = "RS256"
    const jwks = { keys: [publicJwk] }
    const baseClaims = {
      iss: config.issuer,
      aud: config.clientId,
      sub: "subject-1",
      preferred_username: "alice",
      nonce: "nonce",
      iat: now / 1000,
      exp: now / 1000 + 60,
    }
    const valid = await tokenCreate(pair.privateKey, baseClaims)
    expect((await zitadelIdTokenValidate(valid, config, "nonce", jwks, () => now)).success).toBe(true)
    const validParts = valid.split(".")
    const nonCanonicalSignature = nonCanonicalBase64UrlVariant(validParts[2] ?? "")
    expect(nonCanonicalSignature).toBeDefined()
    if (nonCanonicalSignature !== undefined) {
      expect(
        (
          await zitadelIdTokenValidate(
            `${validParts[0]}.${validParts[1]}.${nonCanonicalSignature}`,
            config,
            "nonce",
            jwks,
            () => now,
          )
        ).success,
      ).toBe(false)
    }
    expect(
      (
        await zitadelIdTokenValidate(
          await tokenCreate(pair.privateKey, { ...baseClaims, nonce: "wrong" }),
          config,
          "nonce",
          jwks,
          () => now,
        )
      ).success,
    ).toBe(false)
    expect(
      (
        await zitadelIdTokenValidate(
          await tokenCreate(pair.privateKey, { ...baseClaims, iss: "https://other.example" }),
          config,
          "nonce",
          jwks,
          () => now,
        )
      ).success,
    ).toBe(false)
    expect(
      (
        await zitadelIdTokenValidate(
          await tokenCreate(pair.privateKey, { ...baseClaims, aud: "other-client" }),
          config,
          "nonce",
          jwks,
          () => now,
        )
      ).success,
    ).toBe(false)
    const tampered = valid.endsWith("x") ? `${valid.slice(0, -1)}y` : `${valid.slice(0, -1)}x`
    expect((await zitadelIdTokenValidate(tampered, config, "nonce", jwks, () => now)).success).toBe(false)
    expect(
      (
        await zitadelIdTokenValidate(
          await tokenCreate(pair.privateKey, { ...baseClaims, exp: now / 1000 - 1 }),
          config,
          "nonce",
          jwks,
          () => now,
        )
      ).success,
    ).toBe(false)
    expect(
      (
        await zitadelIdTokenValidate(
          await tokenCreate(pair.privateKey, { ...baseClaims, iat: now / 1000 + 1 }),
          config,
          "nonce",
          jwks,
          () => now,
        )
      ).success,
    ).toBe(false)
  })
})
