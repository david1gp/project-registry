import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectRegistryDaemonConfigFromEnv } from "../../src/runtime/projectRegistryDaemonConfigFromEnv.js"

const migrationDirectory = import.meta.dir
const installer = join(migrationDirectory, "install-project-registryd.bash")
const identityFixtureDirectory = join(migrationDirectory, "fixtures", "caddy-service-identity")
const accessLogPermissions = join(migrationDirectory, "caddy-access-log-permissions.bash")

type CommandResult = {
  exitCode: number
  stderr: string
  stdout: string
}

async function command(
  commandName: string,
  args: string[],
  environment: Record<string, string>,
): Promise<CommandResult> {
  const process = Bun.spawn([commandName, ...args], { env: environment, stderr: "pipe", stdout: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stderr, stdout }
}

describe("project-registryd production staging", () => {
  test("provisions only the Caddy access-log directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-log-permissions-"))
    const user = (await command("id", ["-un"], Bun.env as Record<string, string>)).stdout.trim()
    const group = (await command("id", ["-gn"], Bun.env as Record<string, string>)).stdout.trim()
    const root = join(directory, "logs")
    const existingFile = join(root, "projects", "unexpected-entry")
    const userId = Number((await command("id", ["-u"], Bun.env as Record<string, string>)).stdout.trim())
    const groupId = Number((await command("id", ["-g"], Bun.env as Record<string, string>)).stdout.trim())

    try {
      await mkdir(join(root, "projects"), { recursive: true, mode: 0o777 })
      await writeFile(existingFile, "leave me\n", { mode: 0o666 })
      await chmod(existingFile, 0o666)
      const result = await command(
        "bash",
        ["-c", '. "$1"; caddy_access_log_root_prepare "$2" "$3" "$4"', "bash", accessLogPermissions, root, user, group],
        Bun.env as Record<string, string>,
      )

      expect(result.exitCode).toBe(0)
      for (const path of [root, join(root, "projects"), join(root, "quarantine")]) {
        expect((await stat(path)).mode & 0o777).toBe(0o700)
      }
      expect((await stat(root)).uid).toBe(userId)
      expect((await stat(root)).gid).toBe(groupId)
      expect(await readFile(existingFile, "utf8")).toBe("leave me\n")
      expect((await stat(existingFile)).mode & 0o777).toBe(0o666)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("accepts only a matching non-root authoritative Caddy identity", async () => {
    const identityScript = join(migrationDirectory, "caddy-service-identity.bash")
    const run = async (fixture: string, configured: Record<string, string> = {}) =>
      command(
        "bash",
        ["-c", `. "$1"; caddy_service_identity_load; printf '%s:%s\\n' "$CADDY_USER" "$CADDY_GROUP"`, "bash", identityScript],
        {
          ...(Bun.env as Record<string, string>),
          CADDY_SERVICE_IDENTITY_FILE: join(identityFixtureDirectory, fixture),
          ...configured,
        },
      )

    const matching = await run("matching.properties")
    expect(matching.exitCode).toBe(0)
    expect(matching.stdout).toBe("caddy:caddy\n")

    const distinct = await run("distinct.properties")
    expect(distinct.exitCode).toBe(0)
    expect(distinct.stdout).toBe("nobody:nogroup\n")

    const configuredDistinct = await run("distinct.properties", { CADDY_USER: "nobody", CADDY_GROUP: "nogroup" })
    expect(configuredDistinct.exitCode).toBe(0)
    expect(configuredDistinct.stdout).toBe("nobody:nogroup\n")

    const mismatching = await run("mismatching.properties", { CADDY_USER: "caddy", CADDY_GROUP: "caddy" })
    expect(mismatching.exitCode).toBe(1)
    expect(mismatching.stderr).toContain("mismatches caddy.service User")

    for (const fixture of ["missing.properties", "root.properties"]) {
      const result = await run(fixture)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("authoritative caddy.service")
    }
  })

  test("contains the production daemon settings and no OIDC secret values", async () => {
    const environment = await readFile(join(migrationDirectory, "project-registryd.env"), "utf8")

    for (const setting of [
      "PROJECT_REGISTRY_REPOSITORY_PATH=/home/caddy/project-registry-history",
      "PROJECT_REGISTRY_WEB_HOST=127.0.0.1",
      "PROJECT_REGISTRY_WEB_PORT=8080",
      "PROJECT_REGISTRY_CADDY_BINARY=/home/caddy/.local/bin/caddy",
      "PROJECT_REGISTRY_CADDY_ADMIN_URL=http://127.0.0.1:2019",
      "PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG=true",
      "PROJECT_REGISTRY_HTTPS_LISTENER=:443",
      "PROJECT_REGISTRY_PORT_FROM=3000",
      "PROJECT_REGISTRY_PORT_TO=3999",
      "# PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT=/var/lib/project-registry/caddy-access-logs",
    ]) {
      expect(environment).toContain(setting)
    }

    expect(environment).not.toMatch(/PROJECT_REGISTRY_OIDC_(CLIENT_SECRET|COOKIE_SECRET)=\S+/)
    expect(environment).not.toMatch(/CADDY_PROJECTS_OIDC_(CLIENT_SECRET|COOKIE_SECRET)=\S+/)
    expect(environment).not.toMatch(/ZITADEL_MANAGEMENT_TOKEN=\S+/)
    expect(environment).toContain("25 MiB")
    expect(environment).toContain("225 MiB/project")
  })

  test("references the copied OIDC file and uses a stable absolute Bun entrypoint", async () => {
    const service = await readFile(join(migrationDirectory, "project-registryd.service"), "utf8")
    const installerSource = await readFile(installer, "utf8")

    expect(service).toContain("EnvironmentFile=/etc/project-registry/leonardomora.oidc.env")
    expect(service).toContain("EnvironmentFile=/etc/project-registry/zitadel.env")
    expect(service).toContain("UMask=0077")
    expect(service).toContain(
      "ExecStart=/usr/local/bin/project-registry-bun /home/caddy/project-registry/dist/daemon.js",
    )
    expect(service).not.toContain("/usr/bin/env bun")
    expect(service).not.toContain("/home/caddy/.bun/bin")
    expect(installerSource).toContain("run build:lib")
    expect(installerSource).toContain("PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG=true")
    expect(installerSource).toContain("BUN_BIN is required")
    expect(installerSource).toContain('"$BUN_BIN" --version')
    expect(installerSource).toContain(
      'PROJECT_REGISTRY_BUN_RUNTIME_PATH="${PROJECT_REGISTRY_BUN_RUNTIME_PATH:-/usr/local/bin/project-registry-bun}"',
    )
    expect(installerSource).toContain('"$INSTALL_BIN" -d -o root -g root -m 0755 "$bun_runtime_directory"')
    expect(installerSource).toContain('"$INSTALL_BIN" -o root -g root -m 0755 "$BUN_BIN" "$PROJECT_REGISTRY_BUN_RUNTIME_PATH"')
    expect(installerSource).toContain('chown root:root "$PROJECT_REGISTRY_BUN_RUNTIME_PATH"')
    expect(installerSource).not.toContain(
      'install -o caddy -g caddy -m 0755 "$BUN_BIN" "$PROJECT_REGISTRY_BUN_RUNTIME_PATH"',
    )
    expect(installerSource).not.toContain('chown caddy:caddy "$PROJECT_REGISTRY_BUN_RUNTIME_PATH"')
    expect(installerSource).toContain("/home/david/leo/leo-server/caddy/oidc/leonardomora.oidc.env")
    expect(installerSource).toContain("-m 0640")
  })

  test("keeps Caddy file-writer modes without installer auditing or a Caddy drop-in", async () => {
    const installerSource = await readFile(installer, "utf8")
    const caddyConfigSource = await readFile(join(migrationDirectory, "..", "..", "src", "caddy", "caddyConfigGenerate.ts"), "utf8")

    expect(installerSource).not.toContain("caddy_access_log_audit")
    expect(installerSource).not.toContain("UMask drop-in")
    expect(caddyConfigSource).toContain('dir_mode: "0700"')
    expect(caddyConfigSource).toContain('mode: "0600"')
  })

  test("starts after and wants the existing system Caddy service", async () => {
    const service = await readFile(join(migrationDirectory, "project-registryd.service"), "utf8")

    expect(service).toContain("After=network-online.target caddy.service")
    expect(service).toContain("Wants=network-online.target caddy.service")
  })

  test("uses a traversable runtime directory without broad socket permissions", async () => {
    const service = await readFile(join(migrationDirectory, "project-registryd.service"), "utf8")

    expect(service).toContain("User=root")
    expect(service).toContain("Group=root")
    expect(service).toContain("RuntimeDirectory=project-registry")
    expect(service).toContain("RuntimeDirectoryMode=0755")
    expect(service).not.toContain("RuntimeDirectoryMode=0700")
  })

  test("centralizes Leo OIDC mapping in the standalone installer", async () => {
    const installerSource = await readFile(installer, "utf8")

    expect(installerSource).toContain("LEONARDOMORA_OIDC_CLIENT_ID")
    expect(installerSource).toContain("LEONARDOMORA_OIDC_CLIENT_SECRET")
    expect(installerSource).toContain("COOKIE_SECRET")
    expect(installerSource).toContain("https://auth.contentoren.de")
    expect(installerSource).toContain(":-zitadel}")
    expect(installerSource).toContain("CADDY_PROJECTS_OIDC_CLIENT_SECRET")
    expect(installerSource).toContain('"$INSTALL_BIN" -o root -g root -m 0600 "$oidc_stage" "$OIDC_TARGET"')
    expect(installerSource).toContain('caddy_access_log_root_prepare "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" "$CADDY_USER" "$CADDY_GROUP"')
    expect(installerSource).toContain('PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT')
    expect(installerSource).toContain('umask 077')
    expect(installerSource).toContain('must not be inside the Git repository')
    expect(installerSource).toContain('chmod 0600 "$output"')
    expect(installerSource).not.toContain('install -o root -g root -m 0640 "$OIDC_SOURCE" "$OIDC_TARGET"')
  })

  test("accepts only an explicit executable Bun source and keeps dry-run write-free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-bun-"))
    try {
      const source = join(directory, "source")
      const oidc = join(directory, "oidc.env")
      const bun = join(directory, "bun")
      const runtime = join(directory, "stable", "bun")
      await mkdir(source, { recursive: true })
      await Bun.write(join(source, "package.json"), "{}\n")
      await Bun.write(oidc, "COOKIE_SECRET=fixture\n")
      await Bun.write(bun, "#!/bin/sh\nexit 0\n")
      await chmod(bun, 0o755)

      const environment = {
        ...(Bun.env as Record<string, string>),
        BUN_BIN: bun,
        PROJECT_REGISTRY_SOURCE: source,
        PROJECT_REGISTRY_OIDC_SOURCE: oidc,
        PROJECT_REGISTRY_BUN_RUNTIME_PATH: runtime,
        PROJECT_REGISTRY_INSTALL_ROOT: join(directory, "install"),
        PROJECT_REGISTRY_CONFIG_ROOT: join(directory, "config"),
        PROJECT_REGISTRY_UNIT_PATH: join(directory, "unit", "project-registryd.service"),
        PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT: join(directory, "logs"),
        CADDY_SERVICE_IDENTITY_FILE: join(identityFixtureDirectory, "matching.properties"),
      }
      const result = await command("bash", [installer, "--dry-run"], environment)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`would stage Bun as ${runtime}`)
      expect(result.stdout).toContain(`${runtime} (root:root, mode 0755)`)
      expect(result.stdout).toContain(`would verify and build with ${bun}`)
      expect(result.stdout).toContain(`would provision Caddy access-log root ${environment.PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT}`)
      expect(result.stdout).not.toContain("fixture")
      expect(result.stderr).not.toContain("fixture")
      expect(await Bun.file(runtime).exists()).toBe(false)
      expect(await Bun.file(environment.PROJECT_REGISTRY_UNIT_PATH).exists()).toBe(false)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("applies standalone without an exported INSTALL_BIN", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-standalone-apply-"))
    try {
      const source = join(directory, "source")
      const oidc = join(directory, "oidc.env")
      const bun = join(directory, "bun")
      const tools = join(directory, "tools")
      const installLog = join(directory, "install.log")
      const install = join(tools, "install")
      const installRoot = join(directory, "install-root")
      const configRoot = join(directory, "config")
      const unitPath = join(directory, "unit", "project-registryd.service")
      const runtimePath = join(directory, "runtime", "bun")

      await mkdir(source, { recursive: true })
      await mkdir(tools, { recursive: true })
      await Bun.write(join(source, "package.json"), "{}\n")
      await Bun.write(
        oidc,
        "PROJECT_REGISTRY_OIDC_CLIENT_ID=id\nPROJECT_REGISTRY_OIDC_CLIENT_SECRET=secret\nPROJECT_REGISTRY_OIDC_COOKIE_SECRET=cookie\n",
      )
      await Bun.write(
        bun,
        '#!/bin/sh\nset -eu\nif [ "$1" = "--version" ]; then exit 0; fi\nif [ "$1" = "run" ] && [ "$2" = "build:lib" ]; then mkdir -p dist node_modules; printf \'daemon\\n\' > dist/daemon.js; exit 0; fi\nexit 1\n',
      )
      await Bun.write(
        install,
        '#!/bin/sh\nset -eu\nprintf \'%s\\n\' "$*" >> "$INSTALL_LOG"\nmode=\nif [ "$1" = "-d" ]; then directory=1; shift; else directory=0; fi\nwhile [ "$1" = "-o" ] || [ "$1" = "-g" ] || [ "$1" = "-m" ]; do\n  case "$1" in -m) mode="$2";; esac\n  shift 2\ndone\nif [ "$1" = "--" ]; then shift; fi\nif [ "$directory" -eq 1 ]; then\n  for path do mkdir -p "$path"; [ -z "$mode" ] || chmod "$mode" "$path"; done\nelse\n  cp "$1" "$2"; [ -z "$mode" ] || chmod "$mode" "$2"\nfi\n',
      )
      await Bun.write(join(tools, "chown"), "#!/bin/sh\nexit 0\n")
      await Bun.write(join(tools, "id"), '#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "-u" ]; then printf \'0\\n\'; else exec /usr/bin/id "$@"; fi\n')
      await Bun.write(join(tools, "systemd-analyze"), "#!/bin/sh\nexit 0\n")
      await chmod(bun, 0o755)
      await chmod(install, 0o755)
      await chmod(join(tools, "chown"), 0o755)
      await chmod(join(tools, "id"), 0o755)
      await chmod(join(tools, "systemd-analyze"), 0o755)

      const environment = {
        ...(Bun.env as Record<string, string>),
        BUN_BIN: bun,
        PATH: `${tools}:${Bun.env.PATH ?? "/usr/bin:/bin"}`,
        INSTALL_LOG: installLog,
        PROJECT_REGISTRY_SOURCE: source,
        PROJECT_REGISTRY_OIDC_SOURCE: oidc,
        PROJECT_REGISTRY_INSTALL_ROOT: installRoot,
        PROJECT_REGISTRY_CONFIG_ROOT: configRoot,
        PROJECT_REGISTRY_UNIT_PATH: unitPath,
        PROJECT_REGISTRY_BUN_RUNTIME_PATH: runtimePath,
        PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT: "",
        CADDY_SERVICE_IDENTITY_FILE: join(identityFixtureDirectory, "matching.properties"),
      }
      delete environment.INSTALL_BIN

      const result = await command("bash", [installer, "--apply"], environment)

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stderr).toBe("")
      expect(await Bun.file(join(configRoot, "project-registryd.env")).exists()).toBe(true)
      expect(await Bun.file(unitPath).exists()).toBe(true)
      expect(await readFile(installLog, "utf8")).not.toContain("umask")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("keeps installer and runtime access-log root policy in parity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-root-policy-"))
    try {
      const source = join(directory, "source")
      const oidc = join(directory, "oidc.env")
      const bun = join(directory, "bun")
      const repository = join(directory, "repository")
      await mkdir(source, { recursive: true })
      await Bun.write(join(source, "package.json"), "{}\n")
      await Bun.write(oidc, "COOKIE_SECRET=fixture\n")
      await Bun.write(bun, "#!/bin/sh\nexit 0\n")
      await chmod(bun, 0o755)

      const roots: Array<string | undefined> = [
        undefined,
        "/var/lib/project-registry/caddy-access-logs",
        "/",
        repository,
        join(repository, "logs"),
        `${repository}/../outside`,
        `${repository}//logs`,
        `${repository}/./logs`,
        "relative",
        `${repository}\\logs`,
        `${directory}/\nlogs`,
      ]
      for (const root of roots) {
        const runtimeEnvironment = {
          PROJECT_REGISTRY_REPOSITORY_PATH: repository,
          ...(root === undefined ? {} : { PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT: root }),
          CADDY_SERVICE_IDENTITY_FILE: join(identityFixtureDirectory, "matching.properties"),
        }
        const runtimeR = projectRegistryDaemonConfigFromEnv(runtimeEnvironment)
        const installerEnvironment = {
          ...(Bun.env as Record<string, string>),
          BUN_BIN: bun,
          PROJECT_REGISTRY_SOURCE: source,
          PROJECT_REGISTRY_OIDC_SOURCE: oidc,
          PROJECT_REGISTRY_REPOSITORY_PATH: repository,
          PROJECT_REGISTRY_INSTALL_ROOT: join(directory, "install"),
          PROJECT_REGISTRY_CONFIG_ROOT: join(directory, "config"),
          PROJECT_REGISTRY_UNIT_PATH: join(directory, "unit", "project-registryd.service"),
          ...(root === undefined ? {} : { PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT: root }),
        }
        if (root === undefined) delete installerEnvironment.PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT

        const installerR = await command("bash", [installer, "--dry-run"], installerEnvironment)
        expect(installerR.exitCode === 0).toBe(runtimeR.success)
      }
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("rejects a missing Bun source before any staging", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-bun-invalid-"))
    try {
      const source = join(directory, "source")
      const oidc = join(directory, "oidc.env")
      await mkdir(source, { recursive: true })
      await Bun.write(join(source, "package.json"), "{}\n")
      await Bun.write(oidc, "COOKIE_SECRET=fixture\n")

      const result = await command("bash", [installer, "--dry-run"], {
        ...(Bun.env as Record<string, string>),
        BUN_BIN: join(directory, "missing-bun"),
        PROJECT_REGISTRY_SOURCE: source,
        PROJECT_REGISTRY_OIDC_SOURCE: oidc,
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("BUN_BIN must be an executable absolute path")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("cannot control a service during preparation", async () => {
    const installer = await readFile(join(migrationDirectory, "install-project-registryd.bash"), "utf8")

    expect(installer).not.toMatch(/\bsystemctl\s+(start|enable|restart|stop|reload|daemon-reload)\b/)
    expect(installer).not.toMatch(/\b(start|enable|restart|stop|reload)\b.*service/i)
  })
})
