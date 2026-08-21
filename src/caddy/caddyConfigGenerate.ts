import * as a from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { projectAccessLogCaddyRetention } from "../access-log/projectAccessLogCaddyRetention.js"
import { projectAccessLogId } from "../access-log/projectAccessLogId.js"
import { projectAccessLogPath } from "../access-log/projectAccessLogPath.js"
import type { Project } from "../project/Project.js"
import { projectSchema } from "../project/projectSchema.js"
import type { CaddyConfig } from "./CaddyConfig.js"
import type { CaddyConfigOptions, OidcOptions } from "./caddyConfigOptionsSchema.js"
import { caddyConfigOptionsSchema } from "./caddyConfigOptionsSchema.js"
import { caddyDocsTemplate } from "./caddyDocsTemplate.js"

function projectIsActive(project: Project): boolean {
  return project.caddy !== undefined && project.caddy !== null && !project.caddy.disabled
}

function projectDomain(project: Project): string {
  return project.caddy?.domains[0] ?? project.name
}

function stringCompare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function activeProjects(projects: readonly Project[]): Project[] {
  return projects.filter(projectIsActive).sort((left, right) => {
    const domainOrder = projectDomain(left).localeCompare(projectDomain(right))
    if (domainOrder !== 0) return domainOrder

    const ownerOrder = stringCompare(left.owner, right.owner)
    if (ownerOrder !== 0) return ownerOrder
    return stringCompare(left.name, right.name)
  })
}

function oidcNormalized(oidc: OidcOptions): Required<OidcOptions> {
  return {
    providerName: oidc.providerName,
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    scope: oidc.scope ?? ["openid", "email", "profile"],
    username: oidc.username ?? "email",
    cookieName: oidc.cookieName ?? "caddy",
    cookieSecret: oidc.cookieSecret,
    cookieMaxAge: oidc.cookieMaxAge ?? "168h",
    redirectUrl: oidc.redirectUrl ?? "/oauth2/callback",
  }
}

function oidcHandler(providerName: string): Record<string, unknown> {
  return {
    handler: "oidc",
    provider: providerName,
    policies: [
      {
        action: "allow",
        match: {
          user: {
            usernames: ["*"],
          },
        },
      },
    ],
  }
}

function docsRoutes(docsRoot: string): Record<string, unknown>[] {
  return [
    {
      group: "docs",
      match: [
        {
          path_regexp: {
            name: "project_docs",
            pattern: "^/docs/((?:[A-Za-z0-9][A-Za-z0-9._-]*/)*[A-Za-z0-9][A-Za-z0-9._-]*\\.md)$",
          },
        },
      ],
      handle: [
        {
          handler: "subroute",
          routes: [
            {
              handle: [
                { handler: "vars", root: docsRoot },
                {
                  handler: "headers",
                  response: {
                    set: {
                      "Content-Type": ["text/html; charset=utf-8"],
                      "Content-Security-Policy": [
                        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'",
                      ],
                      "X-Content-Type-Options": ["nosniff"],
                    },
                  },
                },
                { handler: "templates" },
                { handler: "static_response", body: caddyDocsTemplate },
              ],
            },
          ],
        },
      ],
    },
    {
      group: "docs",
      match: [{ path: ["/docs", "/docs/*"] }],
      handle: [
        {
          handler: "subroute",
          routes: [
            {
              handle: [{ handler: "static_response", body: "Not found", status_code: 404 }],
            },
          ],
        },
      ],
    },
  ]
}

function proxyHandler(project: Project): Record<string, unknown> {
  const caddy = project.caddy
  if (caddy === undefined || caddy === null) return {}

  const proxy: Record<string, unknown> = {
    handler: "reverse_proxy",
    upstreams: [{ dial: `localhost:${caddy.port}` }],
  }

  if (caddy.flushInterval !== undefined) proxy.flush_interval = caddy.flushInterval

  const headerEntries = Object.entries(caddy.headerUp)
  if (headerEntries.length > 0) {
    const set = Object.fromEntries(headerEntries.map(([key, value]) => [key, [value]])) as Record<string, string[]>
    proxy.headers = { request: { set } }
  }

  return proxy
}

function staticHandles(project: Project): Record<string, unknown>[] {
  const caddy = project.caddy
  if (caddy === undefined || caddy === null) return []

  const handles: Record<string, unknown>[] = [{ handler: "vars", root: caddy.path }]
  if (caddy.spa === true) {
    handles.push({
      handler: "rewrite",
      uri: "{http.matchers.file.relative}",
    })
  }

  const fileServer: Record<string, unknown> = { handler: "file_server" }
  if (caddy.browse) {
    fileServer.browse = caddy.browseTemplate ? { template_file: caddy.browseTemplate } : {}
  }
  handles.push(fileServer)
  return handles
}

function staticRoute(project: Project): Record<string, unknown> {
  const caddy = project.caddy
  if (caddy === undefined || caddy === null) return {}

  const handles = staticHandles(project)
  if (caddy.spa === true) {
    return {
      match: [
        {
          file: {
            root: caddy.path,
            try_files: ["{http.request.uri.path}", "/index.html"],
          },
        },
      ],
      handle: handles,
    }
  }

  return { handle: handles }
}

function projectRoute(project: Project, options: CaddyConfigOptions): Record<string, unknown> {
  const caddy = project.caddy
  if (caddy === undefined || caddy === null) return {}

  const inner: Record<string, unknown>[] = []
  const routedValue = caddy.routed ?? (caddy.kind === "static" ? "static" : String(caddy.port))
  inner.push({
    handle: [
      {
        handler: "headers",
        response: {
          set: {
            Routed: [routedValue],
          },
        },
      },
    ],
  })

  const pathOidc = caddy.oidcPaths !== undefined && caddy.oidcPaths.length > 0 && options.oidc !== undefined
  const fullOidc = !pathOidc && caddy.access === "internal" && options.oidc !== undefined

  if (fullOidc && options.oidc !== undefined) {
    inner.push({ handle: [oidcHandler(options.oidc.providerName)] })
  }

  const docsRoot =
    caddy.docs === true
      ? caddy.docsPath && caddy.docsPath !== ""
        ? caddy.docsPath
        : caddy.path !== ""
          ? `${caddy.path}/docs`
          : ""
      : ""
  if (docsRoot !== "") inner.push(...docsRoutes(docsRoot))

  if (caddy.denyDotfiles === true) {
    inner.push({
      match: [{ path_regexp: { pattern: "^/\\..*" } }],
      handle: [{ handler: "static_response", body: "Not found", status_code: 404 }],
    })
  }

  if (caddy.staticAllow && caddy.staticAllow.length > 0 && caddy.kind === "static") {
    inner.push({
      match: [{ not: caddy.staticAllow.map((path) => ({ path: [path] })) }],
      handle: [
        {
          handler: "static_response",
          body: "Only markdown and YAML files are accessible",
          status_code: 403,
        },
      ],
    })
  }

  if (pathOidc && options.oidc !== undefined) {
    const oidcPaths = caddy.oidcPaths ?? []
    if (caddy.kind === "proxy") {
      inner.push({
        match: [{ path: [...oidcPaths] }],
        handle: [
          {
            handler: "subroute",
            routes: [{ handle: [oidcHandler(options.oidc.providerName), proxyHandler(project)] }],
          },
        ],
      })
      inner.push({ handle: [proxyHandler(project)] })
    } else {
      const staticProjectRoute = staticRoute(project)
      inner.push({
        match: [{ path: [...oidcPaths] }],
        handle: [
          {
            handler: "subroute",
            routes: [
              {
                handle: [
                  oidcHandler(options.oidc.providerName),
                  ...(staticProjectRoute.handle as Record<string, unknown>[]),
                ],
                ...(staticProjectRoute.match ? { match: staticProjectRoute.match } : {}),
              },
            ],
          },
        ],
      })
      inner.push(staticProjectRoute)
    }
  } else if (caddy.kind === "static") {
    inner.push(staticRoute(project))
  } else {
    inner.push({ handle: [proxyHandler(project)] })
  }

  return {
    match: [{ host: [...caddy.domains] }],
    terminal: true,
    handle: [
      {
        handler: "subroute",
        routes: inner,
      },
    ],
  }
}

function projectAccessLogEncoder(): Record<string, unknown> {
  return {
    format: "filter",
    wrap: { format: "json" },
    fields: {
      "request>headers": { filter: "delete" },
      resp_headers: { filter: "delete" },
      "request>uri": { filter: "regexp", regexp: "\\?.*$", value: "" },
      "request>remote_ip": { filter: "ip_mask", ipv4_cidr: 24, ipv6_cidr: 64 },
      "request>client_ip": { filter: "ip_mask", ipv4_cidr: 24, ipv6_cidr: 64 },
    },
  }
}

function projectAccessLogConfig(
  projects: readonly Project[],
  root: string,
): Result<{
  logging: { logs: Record<string, unknown> }
  serverLogs: { logger_names: Record<string, string[]>; should_log_credentials: false }
}> {
  const op = "caddyConfigGenerate"
  const logs: Record<string, unknown> = {}
  const loggerNames: Record<string, string[]> = {}
  const exclusions: string[] = []

  for (const project of projects) {
    const id = projectAccessLogId(project)
    const pathR = projectAccessLogPath(root, project)
    if (!pathR.success) return createResultError(op, pathR.errorMessage)

    const accessLogger = `http.log.access.${id}`
    logs[id] = {
      writer: {
        output: "file",
        filename: pathR.data,
        mode: "0600",
        dir_mode: "0700",
        roll_size_mb: 25,
        roll_at: ["00:00"],
        roll_gzip: true,
        roll_keep_days: projectAccessLogCaddyRetention.rollKeepDays,
        roll_keep: projectAccessLogCaddyRetention.rollKeep,
      },
      encoder: projectAccessLogEncoder(),
      include: [accessLogger],
    }
    exclusions.push(accessLogger)
    for (const domain of project.caddy?.domains ?? []) loggerNames[domain] = [id]
  }

  return createResult({
    logging: { logs: { default: { exclude: exclusions }, ...logs } },
    serverLogs: { logger_names: loggerNames, should_log_credentials: false },
  })
}

function projectDomainsValidate(projects: readonly Project[]): Result<void> {
  const op = "caddyConfigGenerate"
  const domains = new Set<string>()

  for (const project of projects) {
    const caddy = project.caddy
    if (caddy === undefined || caddy === null) continue

    if (caddy.kind === "static" && caddy.path === "") {
      return createResultError(op, `static project requires path: ${project.name}`)
    }

    for (const domain of caddy.domains) {
      if (domains.has(domain)) return createResultError(op, `duplicate domain: ${domain}`)
      domains.add(domain)
    }
  }

  return createResult(undefined)
}

export function caddyConfigGenerate(projects: unknown, options: unknown = {}): Result<CaddyConfig> {
  const op = "caddyConfigGenerate"
  try {
    const projectsParsed = a.safeParse(a.array(projectSchema), projects)
    if (!projectsParsed.success) return createResultError(op, `invalid projects: ${a.summarize(projectsParsed.issues)}`)

    const optionsParsed = a.safeParse(caddyConfigOptionsSchema, options)
    if (!optionsParsed.success) return createResultError(op, `invalid options: ${a.summarize(optionsParsed.issues)}`)

    const active = activeProjects(projectsParsed.output)
    const domainsResult = projectDomainsValidate(active)
    if (!domainsResult.success) return domainsResult

    const config: CaddyConfig = {
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [optionsParsed.output.httpsListener],
              routes: active.map((project) => projectRoute(project, optionsParsed.output)),
            },
          },
        },
      },
    }

    if (optionsParsed.output.caddyAccessLogRoot !== undefined && active.length > 0) {
      const accessLogR = projectAccessLogConfig(active, optionsParsed.output.caddyAccessLogRoot)
      if (!accessLogR.success) return accessLogR
      config.apps.http.servers.srv0.logs = accessLogR.data.serverLogs
      config.logging = accessLogR.data.logging
    }

    if (optionsParsed.output.oidc !== undefined) {
      const oidc = oidcNormalized(optionsParsed.output.oidc)
      const provider = {
        issuer: oidc.issuer,
        client_id: oidc.clientId,
        client_secret: oidc.clientSecret,
        scope: oidc.scope,
        username: oidc.username,
        authenticators: {
          authenticators: [
            {
              authenticator: "cookie",
              name: oidc.cookieName,
              secret: oidc.cookieSecret,
              max_age: oidc.cookieMaxAge,
              redirect_url: oidc.redirectUrl,
            },
          ],
        },
      }
      config.apps.oidc = { providers: Object.fromEntries([[oidc.providerName, provider]]) }
    }

    return createResult(config)
  } catch {
    return createResultError(op, "invalid Caddy generation input")
  }
}
