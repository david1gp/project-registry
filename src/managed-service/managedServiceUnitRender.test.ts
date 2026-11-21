import { describe, expect, test } from "bun:test"
import type { ManagedServiceUnitSpec } from "./ManagedServiceUnitSpec.js"
import { managedServiceUnitMarker } from "./managedServiceUnitMarker.js"
import { managedServiceUnitRender } from "./managedServiceUnitRender.js"

const spec: ManagedServiceUnitSpec = {
  owner: "leo",
  project: "archive",
  service: "web",
  user: "projects",
  group: "projects",
  homeDirectory: "/home/projects",
  projectsRoot: "/projects",
  workingDirectory: "/projects/archive",
  slice: "projects.slice",
  pathValue: "/usr/local/bin:/usr/bin:/bin",
  port: 4310,
  domains: ["archive.wonder1.de", "archiv.wonder1.de"],
  envFile: "/projects/archive/.env.production",
  command: "/projects/archive/node_modules/.bin/vite",
  args: ["--port", "4310", "--strictPort", "--host", "127.0.0.1"],
}

function lines(rendered: string): string[] {
  return rendered.split("\n")
}

describe("managedServiceUnitRender", () => {
  test("renders a marker-first, unprivileged, hardened unit on the registry port", () => {
    const result = managedServiceUnitRender(spec)
    expect(result.success).toBe(true)
    if (!result.success) return
    const rendered = lines(result.data)
    expect(rendered[0]).toBe(managedServiceUnitMarker)
    expect(rendered).toEqual(
      expect.arrayContaining([
        "User=projects",
        "Group=projects",
        "WorkingDirectory=/projects/archive",
        "UMask=0002",
        "Environment=PORT=4310",
        "Environment=HOST=127.0.0.1",
        "Environment=__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=archive.wonder1.de,archiv.wonder1.de",
        "EnvironmentFile=-/projects/archive/.env.production",
        "ExecStart=/projects/archive/node_modules/.bin/vite --port 4310 --strictPort --host 127.0.0.1",
        "Restart=on-failure",
        "Slice=projects.slice",
        "NoNewPrivileges=yes",
        "ProtectSystem=strict",
        "ProtectHome=tmpfs",
        "BindPaths=/home/projects",
        "ReadWritePaths=/projects /home/projects",
        "InaccessiblePaths=-/servers",
        "PrivateTmp=yes",
        "WantedBy=multi-user.target",
      ]),
    )
  })

  test("a SIGTERM stop is clean so stopping never leaves a failed unit, while crashes still restart", () => {
    const result = managedServiceUnitRender(spec)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(lines(result.data)).toEqual(
      expect.arrayContaining(["SuccessExitStatus=143 SIGTERM", "Restart=on-failure", "RestartSec=5"]),
    )
  })

  test("bare executables run through env so the configured PATH applies; no env file means no EnvironmentFile", () => {
    const { envFile: _envFile, ...withoutEnvFile } = spec
    const result = managedServiceUnitRender({ ...withoutEnvFile, command: "bun", args: ["run", "dev"] })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(lines(result.data)).toContain("ExecStart=/usr/bin/env bun run dev")
    expect(result.data).not.toContain("EnvironmentFile=")
  })

  test("renders a preview service with preview:start and its .env.preview file", () => {
    const result = managedServiceUnitRender({
      ...spec,
      command: "bun",
      args: ["run", "preview:start"],
      envFile: "/projects/archive/.env.preview",
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(lines(result.data)).toEqual(
      expect.arrayContaining([
        "Environment=PORT=4310",
        "Environment=HOST=127.0.0.1",
        "EnvironmentFile=-/projects/archive/.env.preview",
        "ExecStart=/usr/bin/env bun run preview:start",
      ]),
    )
  })

  test("a worker without a port or domains gets no PORT or allowed-hosts environment", () => {
    const { port: _port, ...withoutPort } = spec
    const result = managedServiceUnitRender({
      ...withoutPort,
      domains: [],
      command: "bun",
      args: ["run", "./worker.ts"],
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).not.toContain("PORT=")
    expect(result.data).not.toContain("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS")
    expect(lines(result.data)).toContain("Environment=HOST=127.0.0.1")
  })

  test("escapes systemd % specifiers so argv reaches the process verbatim", () => {
    const result = managedServiceUnitRender({ ...spec, args: ["--format=%h"] })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toContain("--format=%%h")
  })

  test("refuses values that could inject unit directives or shell syntax", () => {
    const unsafe: Partial<ManagedServiceUnitSpec>[] = [
      { args: ["ok\nExecStartPre=/bin/sh"] },
      { args: ["$(id)"] },
      { command: "bun run" },
      { user: "root\nUser=root" },
      { workingDirectory: "/projects/../etc" },
      { envFile: "relative/.env" },
      { domains: ["evil\nUser=root"] },
      { slice: "user.slice\n" },
      { port: 0 },
    ]
    for (const override of unsafe) {
      expect(managedServiceUnitRender({ ...spec, ...override }).success).toBe(false)
    }
  })

  describe("rootless podman container services", () => {
    const image = "localhost/scraper@sha256:bc3b024e7d50605e5ef5b3262a0c48f79c955f45d86d53ab42784fe47e691ad6"
    const containerSpec: ManagedServiceUnitSpec = {
      ...spec,
      project: "scraper",
      service: "default",
      workingDirectory: "/projects/scraper",
      envFile: undefined,
      port: 11111,
      domains: ["scraper.wonder1.de"],
      command: "podman",
      args: ["run", "--publish", "127.0.0.1:11111:8080", "--volume", "/projects/scraper/data:/data:Z", image, "-web"],
      container: {
        engine: "podman",
        name: "proj-scraper-default",
        userId: 994,
        runtimeDirectory: "/run/user/994",
        storageRoot: "/home/projects/.local/share/containers/storage",
      },
    }
    const global = "--root /home/projects/.local/share/containers/storage --runroot /run/user/994/containers"

    test("renders a quadlet-style notify unit with explicit storage, runtime dir and a named clean stop", () => {
      const result = managedServiceUnitRender(containerSpec)
      expect(result.success).toBe(true)
      if (!result.success) return
      const rendered = lines(result.data)
      expect(rendered[0]).toBe(managedServiceUnitMarker)
      expect(rendered).toEqual(
        expect.arrayContaining([
          "Requires=user-runtime-dir@994.service",
          "After=user-runtime-dir@994.service",
          "Type=notify",
          "NotifyAccess=all",
          "User=projects",
          "Group=projects",
          "Environment=XDG_RUNTIME_DIR=/run/user/994",
          "Environment=HOME=/home/projects",
          "Environment=PORT=11111",
          `ExecStart=/usr/bin/env podman ${global} run --rm --replace --name proj-scraper-default --cgroups=split --sdnotify=conmon --detach --log-driver=passthrough --umask=0002 --publish 127.0.0.1:11111:8080 --volume /projects/scraper/data:/data:Z ${image} -web`,
          `ExecStop=/usr/bin/env podman ${global} stop --ignore --time 30 proj-scraper-default`,
          `ExecStopPost=-/usr/bin/env podman ${global} rm --force --ignore proj-scraper-default`,
          "Delegate=yes",
          "KillMode=mixed",
          "TimeoutStopSec=60",
          "Restart=on-failure",
          "Slice=projects.slice",
          "ProtectSystem=strict",
          "ProtectHome=tmpfs",
          "BindPaths=/home/projects /run/user/994",
          "ReadWritePaths=/projects /home/projects /run/user/994",
          "InaccessiblePaths=-/servers",
          "PrivateTmp=yes",
        ]),
      )
    })

    test("drops NoNewPrivileges only for containers so setuid newuidmap can write the userns maps", () => {
      const containerR = managedServiceUnitRender(containerSpec)
      const plainR = managedServiceUnitRender(spec)
      expect(containerR.success && plainR.success).toBe(true)
      if (!containerR.success || !plainR.success) return
      expect(containerR.data).not.toContain("NoNewPrivileges")
      expect(containerR.data).not.toContain("Type=simple")
      expect(plainR.data).toContain("NoNewPrivileges=yes")
      expect(plainR.data).not.toContain("XDG_RUNTIME_DIR")
      expect(plainR.data).not.toContain("Delegate=")
      expect(plainR.data).not.toContain("ExecStop")
    })

    test("refuses non-podman commands and row options that the unit manages", () => {
      const unsafe: Partial<ManagedServiceUnitSpec>[] = [
        { command: "bun", args: ["run", "start"] },
        { args: ["create", image] },
        { args: ["run"] },
        { args: ["run", "--name", "other", image] },
        { args: ["run", "--name=other", image] },
        { args: ["run", "-d", image] },
        { args: ["run", "--rm", image] },
        { args: ["run", "--log-driver=journald", image] },
        { args: ["run", "--root", "/tmp/x", image] },
        { container: { ...containerSpec.container!, name: "Bad Name" } },
        { container: { ...containerSpec.container!, runtimeDirectory: "/run/user/../0" } },
        { container: { ...containerSpec.container!, userId: -1 } },
      ]
      for (const override of unsafe) {
        expect(managedServiceUnitRender({ ...containerSpec, ...override }).success).toBe(false)
      }
    })
  })
})
