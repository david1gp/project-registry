import { expect, test } from "bun:test"
import type { CaddyConfig } from "./CaddyConfig.js"
import { caddyConfigHostnames } from "./caddyConfigHostnames.js"

test("merged hosts include nested and secondary-server sites but not negations, IPs, wildcard or invalid names", () => {
  const config = {
    apps: {
      http: {
        servers: {
          srv0: {
            routes: [
              {
                match: [{ host: ["BASELINE.DEV.", "*.wild.dev", "127.0.0.1", "localhost", "{dynamic.host}"] }],
                handle: [{ handler: "subroute", routes: [{ match: [{ host: ["nested.dev"] }] }] }],
              },
              { match: [{ not: [{ host: ["excluded.dev"] }] }] },
            ],
            listen: [":443"],
          },
          srv1: { routes: [{ match: [{ host: ["secondary.dev", "baseline.dev"] }] }], listen: [":8443"] },
        },
      },
    },
  } as unknown as CaddyConfig
  expect(caddyConfigHostnames(config)).toEqual(["baseline.dev", "nested.dev", "secondary.dev"])
})
