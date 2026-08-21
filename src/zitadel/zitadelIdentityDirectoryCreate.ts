import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { IdentityDirectory } from "../identity/IdentityDirectory.js"
import type { IdentityDirectoryUser } from "../identity/IdentityDirectoryUser.js"
import type { ZitadelIdentityDirectoryOptions } from "./ZitadelIdentityDirectoryOptions.js"
import { zitadelHttpJsonFetch } from "./zitadelHttpJsonFetch.js"

const pageSize = 100
const defaultMaximumResults = 10_000
const maximumMaximumResults = 10_000
const maximumPages = 100
const knownRoles = new Set(["own", "admin", "superadmin"])

type DirectoryConfig = {
  http: ZitadelIdentityDirectoryOptions["http"]
  grantsUrl: string
  orgId: string
  projectId: string
  timeoutMs: ZitadelIdentityDirectoryOptions["timeoutMs"]
  maxBodyBytes: ZitadelIdentityDirectoryOptions["maxBodyBytes"]
  maxResults: number
}

type UserGrant = {
  userId: string
  preferredLoginName: string
  projectId: string
  orgId: string
  roleKeys: readonly string[]
  state: "USER_GRANT_STATE_ACTIVE" | "USER_GRANT_STATE_INACTIVE"
}

function boundedStringIsValid(value: unknown, maximumLength: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function accessTokenIsValid(value: unknown): value is string {
  return boundedStringIsValid(value, 8192)
}

function identityValueIsValid(value: unknown): value is string {
  return boundedStringIsValid(value, 256)
}

function issuerIsValid(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0 &&
      url.search.length === 0 &&
      url.pathname === "/" &&
      url.origin === value
    )
  } catch {
    return false
  }
}

function maximumResultsResolve(value: unknown): number | undefined {
  const maximumResults = value ?? defaultMaximumResults
  if (
    typeof maximumResults !== "number" ||
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > maximumMaximumResults
  ) {
    return undefined
  }
  return maximumResults
}

function configResolve(options: ZitadelIdentityDirectoryOptions): Result<DirectoryConfig> {
  const op = "zitadelIdentityDirectoryCreate"
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.http !== "function" ||
    !issuerIsValid(options.issuer) ||
    !identityValueIsValid(options.orgId) ||
    !identityValueIsValid(options.projectId)
  ) {
    return createResultError(op, "Zitadel identity directory configuration is invalid")
  }
  const maxResults = maximumResultsResolve(options.maxResults)
  if (maxResults === undefined) return createResultError(op, "Zitadel identity directory configuration is invalid")
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)
  ) {
    return createResultError(op, "Zitadel identity directory configuration is invalid")
  }
  if (
    options.maxBodyBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1 || options.maxBodyBytes > 8_388_608)
  ) {
    return createResultError(op, "Zitadel identity directory configuration is invalid")
  }
  return createResult({
    http: options.http,
    grantsUrl: `${options.issuer}/management/v1/users/grants/_search`,
    orgId: options.orgId,
    projectId: options.projectId,
    timeoutMs: options.timeoutMs,
    maxBodyBytes: options.maxBodyBytes,
    maxResults,
  })
}

function recordResolve(value: unknown): Result<Record<string, unknown>> {
  const op = "zitadelIdentityDirectoryResponse"
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createResultError(op, "Zitadel identity directory response is invalid")
  }
  return createResult(value as Record<string, unknown>)
}

function totalResultResolve(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

function grantResolve(value: unknown): Result<UserGrant> {
  const op = "zitadelIdentityDirectoryResponse"
  const recordR = recordResolve(value)
  if (!recordR.success) return recordR
  const record = recordR.data
  const roleKeys = record.roleKeys
  if (
    !identityValueIsValid(record.userId) ||
    !identityValueIsValid(record.preferredLoginName) ||
    !identityValueIsValid(record.projectId) ||
    !identityValueIsValid(record.orgId) ||
    !Array.isArray(roleKeys) ||
    roleKeys.length > 32 ||
    roleKeys.some((role) => !boundedStringIsValid(role, 200)) ||
    new Set(roleKeys).size !== roleKeys.length ||
    (record.state !== "USER_GRANT_STATE_ACTIVE" && record.state !== "USER_GRANT_STATE_INACTIVE")
  ) {
    return createResultError(op, "Zitadel identity directory response is invalid")
  }
  return createResult({
    userId: record.userId,
    preferredLoginName: record.preferredLoginName,
    projectId: record.projectId,
    orgId: record.orgId,
    roleKeys,
    state: record.state,
  })
}

function responsePageResolve(
  value: unknown,
  config: DirectoryConfig,
  offset: number,
  received: number,
): Result<{ grants: readonly UserGrant[]; total: number }> {
  const op = "zitadelIdentityDirectoryResponse"
  const recordR = recordResolve(value)
  if (!recordR.success) return recordR
  const result = recordR.data.result
  const details = recordR.data.details
  const detailsR = recordResolve(details)
  if (!detailsR.success || !Array.isArray(result) || result.length > pageSize) {
    return createResultError(op, "Zitadel identity directory response is invalid")
  }
  const total = totalResultResolve(detailsR.data.totalResult)
  if (total === undefined || total > config.maxResults || total < received + result.length) {
    return createResultError(op, "Zitadel identity directory response is invalid")
  }
  const grants: UserGrant[] = []
  for (const entry of result) {
    const grantR = grantResolve(entry)
    if (!grantR.success) return grantR
    grants.push(grantR.data)
  }
  if (offset !== received) return createResultError(op, "Zitadel identity directory response is invalid")
  return createResult({ grants, total })
}

function queryCreate(kind: "projectIdQuery" | "userIdQuery", value: string, offset: number): string {
  return JSON.stringify({
    query: { offset, limit: pageSize, asc: true },
    queries: [{ [kind]: { [kind === "projectIdQuery" ? "projectId" : "userId"]: value } }],
  })
}

async function grantsList(
  config: DirectoryConfig,
  queryKind: "projectIdQuery" | "userIdQuery",
  queryValue: string,
  accessToken: string,
): PromiseResult<readonly UserGrant[]> {
  const op = "zitadelIdentityDirectoryGrantsList"
  if (!accessTokenIsValid(accessToken)) return createResultError(op, "Zitadel identity directory is unavailable")
  const grants: UserGrant[] = []
  let offset = 0
  for (let page = 0; page < maximumPages; page += 1) {
    const responseR = await zitadelHttpJsonFetch(
      config.http,
      config.grantsUrl,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "x-zitadel-orgid": config.orgId,
        },
        body: queryCreate(queryKind, queryValue, offset),
      },
      { timeoutMs: config.timeoutMs, maxBodyBytes: config.maxBodyBytes },
    )
    if (!responseR.success || !responseR.data.response.ok) {
      return createResultError(op, "Zitadel identity directory is unavailable")
    }
    const pageR = responsePageResolve(responseR.data.body, config, offset, grants.length)
    if (!pageR.success) return pageR
    if (queryKind === "userIdQuery" && pageR.data.grants.some((grant) => grant.userId !== queryValue)) {
      return createResultError(op, "Zitadel identity directory response is invalid")
    }
    grants.push(...pageR.data.grants)
    if (grants.length === pageR.data.total) return createResult(grants)
    if (pageR.data.grants.length === 0 || pageR.data.grants.length < pageSize) {
      return createResultError(op, "Zitadel identity directory response is invalid")
    }
    offset += pageR.data.grants.length
  }
  return createResultError(op, "Zitadel identity directory response is too large")
}

function currentProjectGrantResolve(
  grants: readonly UserGrant[],
  config: DirectoryConfig,
  subject: string,
): Result<UserGrant | undefined> {
  const op = "zitadelIdentityDirectoryGrantResolve"
  const current = grants.filter(
    (grant) =>
      grant.userId === subject &&
      grant.projectId === config.projectId &&
      grant.orgId === config.orgId &&
      grant.state === "USER_GRANT_STATE_ACTIVE",
  )
  if (current.length > 1) return createResultError(op, "Zitadel identity directory returned duplicate project grants")
  const grant = current[0]
  if (grant?.roleKeys.some((role) => !knownRoles.has(role))) {
    return createResultError(op, "Zitadel identity directory returned an unknown project role")
  }
  return createResult(grant)
}

function usersResolve(grants: readonly UserGrant[], config: DirectoryConfig): Result<readonly IdentityDirectoryUser[]> {
  const op = "zitadelIdentityDirectoryUsersList"
  const users: IdentityDirectoryUser[] = []
  const subjects = new Set<string>()
  for (const grant of grants) {
    if (grant.projectId !== config.projectId || grant.orgId !== config.orgId) continue
    if (grant.state !== "USER_GRANT_STATE_ACTIVE") continue
    if (grant.roleKeys.some((role) => !knownRoles.has(role))) {
      return createResultError(op, "Zitadel identity directory returned an unknown project role")
    }
    if (subjects.has(grant.userId)) {
      return createResultError(op, "Zitadel identity directory returned duplicate project grants")
    }
    subjects.add(grant.userId)
    users.push({ subject: grant.userId, preferredUsername: grant.preferredLoginName })
  }
  return createResult(users)
}

export function zitadelIdentityDirectoryCreate(options: ZitadelIdentityDirectoryOptions): Result<IdentityDirectory> {
  const configR = configResolve(options)
  if (!configR.success) return configR
  const config = configR.data
  return createResult({
    async usersList(accessToken: string): PromiseResult<readonly IdentityDirectoryUser[]> {
      const grantsR = await grantsList(config, "projectIdQuery", config.projectId, accessToken)
      if (!grantsR.success) return grantsR
      return usersResolve(grantsR.data, config)
    },
    async userRolesList(subject: string, accessToken: string): PromiseResult<readonly unknown[]> {
      const op = "zitadelIdentityDirectoryUserRolesList"
      if (!identityValueIsValid(subject)) return createResultError(op, "Zitadel identity directory is unavailable")
      const grantsR = await grantsList(config, "userIdQuery", subject, accessToken)
      if (!grantsR.success) return grantsR
      const grantR = currentProjectGrantResolve(grantsR.data, config, subject)
      if (!grantR.success) return grantR
      return createResult(grantR.data?.roleKeys ?? [])
    },
    async userPreferredUsernameResolve(subject: string, accessToken: string): PromiseResult<string> {
      const op = "zitadelIdentityDirectoryUserPreferredUsernameResolve"
      if (!identityValueIsValid(subject)) return createResultError(op, "Zitadel identity directory is unavailable")
      const grantsR = await grantsList(config, "userIdQuery", subject, accessToken)
      if (!grantsR.success) return grantsR
      const grantR = currentProjectGrantResolve(grantsR.data, config, subject)
      if (!grantR.success) return grantR
      if (grantR.data === undefined) return createResultError(op, "Zitadel identity directory is unavailable")
      return createResult(grantR.data.preferredLoginName)
    },
  })
}
