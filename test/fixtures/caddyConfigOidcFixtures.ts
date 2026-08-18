import type { Project } from "../../src/project/Project.js"
import { caddyConfigGenerateFixtures } from "./caddyConfigGenerateFixtures.js"

const oidcHandler = {
  handler: "oidc",
  provider: "zitadel",
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

const internalProxyRoute = {
  match: [{ host: ["hermes.example"] }],
  terminal: true,
  handle: [
    {
      handler: "subroute",
      routes: [
        {
          handle: [{ handler: "headers", response: { set: { Routed: ["9119"] } } }],
        },
        { handle: [oidcHandler] },
        {
          handle: [
            {
              handler: "reverse_proxy",
              upstreams: [{ dial: "localhost:9119" }],
              headers: {
                request: {
                  set: {
                    Host: ["127.0.0.1:9119"],
                    Origin: ["http://127.0.0.1:9119"],
                  },
                },
              },
              flush_interval: -1,
            },
          ],
        },
      ],
    },
  ],
}

const internalStaticRoute = {
  match: [{ host: ["demos.example"] }],
  terminal: true,
  handle: [
    {
      handler: "subroute",
      routes: [
        {
          handle: [{ handler: "headers", response: { set: { Routed: ["static"] } } }],
        },
        { handle: [oidcHandler] },
        {
          handle: [
            { handler: "vars", root: "/home/leo/projects/demos" },
            { handler: "file_server", browse: {} },
          ],
        },
      ],
    },
  ],
}

const pathProxyRoute = {
  match: [{ host: ["path-proxy.example"] }],
  terminal: true,
  handle: [
    {
      handler: "subroute",
      routes: [
        {
          handle: [{ handler: "headers", response: { set: { Routed: ["9119"] } } }],
        },
        {
          match: [{ path: ["/private/*", "/admin"] }],
          handle: [
            {
              handler: "subroute",
              routes: [
                {
                  handle: [oidcHandler, { handler: "reverse_proxy", upstreams: [{ dial: "localhost:9119" }] }],
                },
              ],
            },
          ],
        },
        { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:9119" }] }] },
      ],
    },
  ],
}

const pathStaticRoute = {
  match: [{ host: ["path-static.example"] }],
  terminal: true,
  handle: [
    {
      handler: "subroute",
      routes: [
        {
          handle: [{ handler: "headers", response: { set: { Routed: ["static"] } } }],
        },
        {
          match: [{ path: ["/private/*", "/admin"] }],
          handle: [
            {
              handler: "subroute",
              routes: [
                {
                  handle: [
                    oidcHandler,
                    { handler: "vars", root: "/home/leo/projects/demos" },
                    { handler: "file_server", browse: {} },
                  ],
                },
              ],
            },
          ],
        },
        {
          handle: [
            { handler: "vars", root: "/home/leo/projects/demos" },
            { handler: "file_server", browse: {} },
          ],
        },
      ],
    },
  ],
}

export const caddyConfigOidcFixtures = {
  options: caddyConfigGenerateFixtures.oidcOptions,
  projects: {
    internalProxy: caddyConfigGenerateFixtures.internalProxy,
    internalStatic: caddyConfigGenerateFixtures.internalStatic,
    pathProxy: caddyConfigGenerateFixtures.pathProxy,
    pathStatic: caddyConfigGenerateFixtures.pathStatic,
  } satisfies Record<string, Project>,
  legacyRoutes: {
    internalProxy: internalProxyRoute,
    internalStatic: internalStaticRoute,
    pathProxy: pathProxyRoute,
    pathStatic: pathStaticRoute,
  },
} as const
