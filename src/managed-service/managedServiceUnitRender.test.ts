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

  test("bare executables run through env so the configured PATH applies; no env file means no EnvironmentFile", () => {
    const { envFile: _envFile, ...withoutEnvFile } = spec
    const result = managedServiceUnitRender({ ...withoutEnvFile, command: "bun", args: ["run", "dev"] })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(lines(result.data)).toContain("ExecStart=/usr/bin/env bun run dev")
    expect(result.data).not.toContain("EnvironmentFile=")
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
})
