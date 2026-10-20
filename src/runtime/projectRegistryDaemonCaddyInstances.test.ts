import { expect, test } from "bun:test"
import { caddyInstanceTargetsResolve } from "../caddy/caddyInstanceTargetsResolve.js"
import { projectRegistryDaemonConfigFromEnv } from "./projectRegistryDaemonConfigFromEnv.js"
import { projectRegistryDaemonConfigValidate } from "./projectRegistryDaemonConfigValidate.js"

const repository = { repositoryPath: "/tmp/opencode/repository" }

function dualInstances() {
  return {
    public: {
      adminUrl: "http://localhost:2019",
      httpsListeners: ["203.0.113.10:443"],
      baseConfigPath: "/etc/project-registry/caddy-public.json",
      accessLogRoot: "/var/lib/project-registry/logs-public",
    },
    private: {
      adminUrl: "http://localhost:2020",
      httpsListeners: ["100.122.200.114:443"],
      baseConfigPath: "/etc/project-registry/caddy-private.json",
      accessLogRoot: "/var/lib/project-registry/logs-private",
    },
  }
}

test("absent instances map keeps existing flat public behavior", () => {
  const fromEnv = projectRegistryDaemonConfigFromEnv({ PROJECT_REGISTRY_REPOSITORY_PATH: repository.repositoryPath })
  expect(fromEnv.success).toBe(true)
  if (!fromEnv.success) return
  expect(fromEnv.data.caddyInstances).toBeUndefined()
  expect(fromEnv.data.caddyAdminUrl).toBe("http://localhost:2019")
  expect(fromEnv.data.httpsListener).toBe(":443")

  const targets = caddyInstanceTargetsResolve({
    caddyAdminUrl: fromEnv.data.caddyAdminUrl,
    httpsListener: fromEnv.data.httpsListener,
  })
  expect(targets.private).toBeUndefined()
  expect(targets.public).toEqual({ adminUrl: "http://localhost:2019", httpsListeners: [":443"] })
})

test("valid dual-target config resolves explicit per-target settings", () => {
  const result = projectRegistryDaemonConfigValidate({ ...repository, caddyInstances: dualInstances() })
  expect(result.success).toBe(true)
  if (!result.success) return
  expect(result.data.caddyAdminUrl).toBe("http://localhost:2019")
  expect(result.data.httpsListener).toBe(":443")
  expect(result.data.caddyInstances?.private?.adminUrl).toBe("http://localhost:2020")

  const targets = caddyInstanceTargetsResolve({
    caddyAdminUrl: result.data.caddyAdminUrl,
    httpsListener: result.data.httpsListener,
    caddyInstances: result.data.caddyInstances,
  })
  expect(targets.public).toEqual({
    adminUrl: "http://localhost:2019",
    httpsListeners: ["203.0.113.10:443"],
    baseConfigPath: "/etc/project-registry/caddy-public.json",
    accessLogRoot: "/var/lib/project-registry/logs-public",
  })
  expect(targets.private).toEqual({
    adminUrl: "http://localhost:2020",
    httpsListeners: ["100.122.200.114:443"],
    baseConfigPath: "/etc/project-registry/caddy-private.json",
    accessLogRoot: "/var/lib/project-registry/logs-private",
  })
})

test("private target requires admin, listeners, and baseline config", () => {
  const instances = dualInstances()
  for (const privateOverride of [
    { adminUrl: undefined },
    { httpsListeners: undefined },
    { baseConfigPath: undefined },
  ] as const) {
    expect(
      projectRegistryDaemonConfigValidate({
        ...repository,
        caddyInstances: { public: instances.public, private: { ...instances.private, ...privateOverride } },
      }).success,
    ).toBe(false)
  }
})

test("private admin must be a distinct loopback URL without credentials", () => {
  const instances = dualInstances()
  for (const adminUrl of [
    "http://localhost:2019",
    "http://127.0.0.1:2019",
    "http://user:secret@localhost:2020",
    "http://192.0.2.1:2020",
    "https://example.com:2020",
  ]) {
    expect(
      projectRegistryDaemonConfigValidate({
        ...repository,
        caddyInstances: { public: instances.public, private: { ...instances.private, adminUrl } },
      }).success,
    ).toBe(false)
  }
})

test("dual-target listeners must be explicit addresses with no overlapping binds", () => {
  const instances = dualInstances()
  // Flat ":443" fallback is not an explicit bind once a private target exists.
  expect(
    projectRegistryDaemonConfigValidate({
      ...repository,
      caddyInstances: { private: instances.private },
    }).success,
  ).toBe(false)
  for (const httpsListeners of [[":443"], ["*:443"], ["0.0.0.0:443"], ["[::]:443"], ["100.122.200.114:443"]]) {
    expect(
      projectRegistryDaemonConfigValidate({
        ...repository,
        caddyInstances: {
          public: { ...instances.public, httpsListeners },
          private: instances.private,
        },
      }).success,
    ).toBe(false)
  }
})

test("private access-log root resolves separately and must differ from public", () => {
  const flatRoot = "/var/lib/project-registry/logs"
  const result = projectRegistryDaemonConfigValidate({
    ...repository,
    caddyAccessLogRoot: flatRoot,
    caddyInstances: {
      public: { adminUrl: "http://localhost:2019", httpsListeners: ["203.0.113.10:443"] },
      private: {
        adminUrl: "http://localhost:2020",
        httpsListeners: ["100.122.200.114:443"],
        baseConfigPath: "/etc/project-registry/caddy-private.json",
      },
    },
  })
  expect(result.success).toBe(true)
  if (!result.success) return
  const targets = caddyInstanceTargetsResolve({
    caddyAdminUrl: result.data.caddyAdminUrl,
    httpsListener: result.data.httpsListener,
    caddyAccessLogRoot: result.data.caddyAccessLogRoot,
    caddyInstances: result.data.caddyInstances,
  })
  expect(targets.public.accessLogRoot).toBe(flatRoot)
  expect(targets.private?.accessLogRoot).toBeUndefined()

  const instances = dualInstances()
  expect(
    projectRegistryDaemonConfigValidate({
      ...repository,
      caddyInstances: {
        public: instances.public,
        private: { ...instances.private, accessLogRoot: instances.public.accessLogRoot },
      },
    }).success,
  ).toBe(false)
})

test("unpaired per-instance service identity is rejected", () => {
  const instances = dualInstances()
  expect(
    projectRegistryDaemonConfigValidate({
      ...repository,
      caddyInstances: { public: { ...instances.public, caddyUser: "caddy" }, private: instances.private },
    }).success,
  ).toBe(false)
  const paired = projectRegistryDaemonConfigValidate({
    ...repository,
    caddyInstances: {
      public: { ...instances.public, caddyUser: "caddy", caddyGroup: "caddy" },
      private: { ...instances.private, caddyUser: "caddy", caddyGroup: "caddy" },
    },
  })
  expect(paired.success).toBe(true)
})

test("local mkcert/hosts mode rejects dual-target config", () => {
  const localEnvironment = {
    PROJECT_REGISTRY_REPOSITORY_PATH: repository.repositoryPath,
    PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED: "true",
    PROJECT_REGISTRY_LOCAL_MKCERT_BINARY: "/usr/bin/mkcert",
    PROJECT_REGISTRY_LOCAL_CERTIFICATES_STATE_DIRECTORY: "/tmp/opencode/certificates",
    PROJECT_REGISTRY_LOCAL_HOSTS_FILE: "/var/lib/project-registry-david/hosts",
  }
  expect(projectRegistryDaemonConfigFromEnv(localEnvironment).success).toBe(true)
  expect(
    projectRegistryDaemonConfigFromEnv({
      ...localEnvironment,
      PROJECT_REGISTRY_CADDY_INSTANCES: JSON.stringify({ private: dualInstances().private }),
    }).success,
  ).toBe(false)
})

test("instances JSON environment parses shape and rejects malformed input", () => {
  const environment = { PROJECT_REGISTRY_REPOSITORY_PATH: repository.repositoryPath }
  expect(
    projectRegistryDaemonConfigFromEnv({
      ...environment,
      PROJECT_REGISTRY_CADDY_INSTANCES: JSON.stringify(dualInstances()),
    }),
  ).toMatchObject({ success: true, data: { caddyInstances: { private: { adminUrl: "http://localhost:2020" } } } })
  expect(
    projectRegistryDaemonConfigFromEnv({ ...environment, PROJECT_REGISTRY_CADDY_INSTANCES: "{invalid" }).success,
  ).toBe(false)
  expect(projectRegistryDaemonConfigFromEnv({ ...environment, PROJECT_REGISTRY_CADDY_INSTANCES: "null" }).success).toBe(
    false,
  )
})

test("instance entries reject token, OIDC, and unknown fields", () => {
  const instances = dualInstances()
  for (const caddyInstances of [
    { public: instances.public, private: { ...instances.private, serviceToken: "secret" } },
    { public: { ...instances.public, oidc: { issuer: "https://issuer.example" } }, private: instances.private },
    { public: instances.public, private: instances.private, unknown: true },
  ]) {
    expect(projectRegistryDaemonConfigValidate({ ...repository, caddyInstances }).success).toBe(false)
  }
})
