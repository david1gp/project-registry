import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const migrationDirectory = import.meta.dir
const preparationScript = join(migrationDirectory, "prepare-leo.bash")
const caddyUnitFixture = join(migrationDirectory, "fixtures", "caddy-service", "caddy.service")
const caddyIdentityFixture = join(migrationDirectory, "fixtures", "caddy-service-identity", "distinct.properties")
const softwareProjectsFixture = join(migrationDirectory, "fixtures", "software-projects")

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

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function preparationArguments(
  directory: string,
  options: {
    caddyAdminUrl?: string
    caddyBinaryDestination?: string
    includeLegacyBaseline?: boolean
    includeLiveOidc?: boolean
  } = {},
): Promise<string[]> {
  const legacyRepository = join(directory, "legacy-repository")
  const migratedRepository = join(directory, "migrated-repository")
  const oidcSource = join(directory, "leo.oidc.env")
  const legacyConfig = join(directory, "legacy-caddy.json")
  const binarySource = join(directory, "leo-caddy")
  const candidateOutput = join(directory, "candidate.json")
  const liveData = join(directory, "live-caddy-data")
  const liveConfig = join(directory, "live-caddy", "caddy.json")
  const liveUnit = join(directory, "live-systemd", "caddy.service")

  await mkdir(liveData, { recursive: true })
  await mkdir(join(liveData, "certificates"), { recursive: true })
  await mkdir(join(liveConfig, ".."), { recursive: true })
  await mkdir(join(liveUnit, ".."), { recursive: true })
  await mkdir(legacyRepository, { recursive: true })
  await Bun.write(join(liveData, "certificates", "authoritative.json"), "authoritative-tls-fixture\n")
  await Bun.write(join(liveData, "destination-only.json"), "must-remain\n")
  await Bun.write(
    oidcSource,
    "LEONARDOMORA_OIDC_CLIENT_ID=fixture-client-id\nLEONARDOMORA_OIDC_CLIENT_SECRET=super-secret-client\nCOOKIE_SECRET=super-secret-fixture\n",
  )
  await Bun.write(legacyConfig, "{}\n")
  await Bun.write(liveConfig, "live-caddy-config\n")
  await Bun.write(liveUnit, `[Service]\nUser=caddy\nGroup=caddy\nExecStart=${binarySource} run\n`)
  await Bun.write(binarySource, "caddy-binary-fixture\n")
  await chmod(binarySource, 0o755)
  if (options.includeLiveOidc) {
    await mkdir(join(directory, "system-caddy"), { recursive: true })
    await Bun.write(join(directory, "system-caddy", "leonardomora.oidc.env"), "legacy-primary-oidc\n")
    await Bun.write(join(directory, "system-caddy", "caddy-projects.oidc.env"), "legacy-alias-oidc\n")
  }

  const argumentsList = [
    "--project-registry-source",
    join(directory, "project-registry-source"),
    "--legacy-repository",
    legacyRepository,
    "--migrated-repository",
    migratedRepository,
    "--software-projects",
    softwareProjectsFixture,
    "--software-owner",
    "leo",
    "--candidate-output",
    candidateOutput,
    "--oidc-source",
    oidcSource,
    "--caddy-data-destination",
    liveData,
    "--caddy-backup-root",
    join(directory, "caddy-backups"),
    "--caddy-binary-source",
    binarySource,
    "--caddy-binary-destination",
    options.caddyBinaryDestination ?? join(directory, "system-caddy", "caddy"),
    "--caddy-unit-source",
    caddyUnitFixture,
    "--caddy-unit-destination",
    liveUnit,
    "--caddy-config-destination",
    liveConfig,
    "--caddy-config-stage",
    join(directory, "caddy-staging", "caddy.json"),
    "--caddy-unit-stage",
    join(directory, "caddy-staging", "caddy.service"),
    "--caddy-oidc-destination",
    join(directory, "system-caddy", "leonardomora.oidc.env"),
    "--caddy-oidc-alias-destination",
    join(directory, "system-caddy", "caddy-projects.oidc.env"),
    "--project-registry-install-root",
    join(directory, "project-registry-install"),
    "--project-registry-config-root",
    join(directory, "project-registry-config"),
    "--project-registry-unit-destination",
    join(directory, "systemd", "project-registryd.service"),
  ]
  if (options.includeLegacyBaseline !== false) {
    argumentsList.push("--legacy-caddy-config", legacyConfig)
  }
  if (options.caddyAdminUrl !== undefined) argumentsList.push("--caddy-admin-url", options.caddyAdminUrl)
  return argumentsList
}

describe("Leo preparation", () => {
  test("defaults to a write-free plan and never invokes service control", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-prepare-"))
    try {
      const source = join(directory, "project-registry-source")
      await mkdir(source, { recursive: true })
      await Bun.write(join(source, "package.json"), "{}\n")

      const fakeBin = join(directory, "bin")
      const serviceControlMarker = join(directory, "service-control-called")
      await mkdir(fakeBin, { recursive: true })
      await Bun.write(join(fakeBin, "systemctl"), `#!/bin/sh\ntouch "${serviceControlMarker}"\nexit 99\n`)
      await chmod(join(fakeBin, "systemctl"), 0o755)

      const result = await command("bash", [preparationScript, ...(await preparationArguments(directory))], {
        ...(Bun.env as Record<string, string>),
        PATH: `${fakeBin}:${Bun.env.PATH ?? ""}`,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("mode: dry-run")
      expect(result.stdout).toContain("would back up live Caddy data")
      expect(result.stdout).toContain("would back up live Caddy config")
      expect(result.stdout).toContain("would back up live Caddy unit")
      expect(result.stdout).toContain("would back up existing live Caddy OIDC env files")
      expect(result.stdout).toContain("would stage candidate Caddy config")
      expect(result.stdout).toContain("would stage candidate Caddy unit")
      expect(result.stdout).not.toContain("UMask=0077")
      expect(result.stdout).toContain("stdin-only Caddy validation")
      expect(result.stdout).toContain("would run migration, candidate generation, task-4 semantic parity")
      expect(result.stdout).not.toContain("rsync")
      expect(result.stdout).not.toContain("--delete")
      expect(result.stdout).not.toContain("super-secret-fixture")
      expect(await exists(serviceControlMarker)).toBe(false)
      expect(await exists(join(directory, "candidate.json"))).toBe(false)
      expect(await exists(join(directory, "caddy-backups"))).toBe(false)
      expect(await exists(join(directory, "caddy-staging"))).toBe(false)
      expect(await exists(join(directory, "legacy-repository", "migrations"))).toBe(false)
      expect(await exists(join(directory, "migrated-repository"))).toBe(false)
      expect(await exists(join(source, "dist"))).toBe(false)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("dry-run plans to reuse an identical Caddy binary without changing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-prepare-binary-plan-"))
    try {
      const source = join(directory, "project-registry-source")
      await mkdir(source, { recursive: true })
      await Bun.write(join(source, "package.json"), "{}\n")
      const binaryAlias = join(directory, "caddy-alias")
      await symlink(join(directory, "leo-caddy"), binaryAlias)

      const result = await command(
        "bash",
        [
          preparationScript,
          "--dry-run",
          ...(await preparationArguments(directory, { caddyBinaryDestination: binaryAlias })),
        ],
        Bun.env as Record<string, string>,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("would leave Caddy binary untouched and verify capabilities")
      expect(result.stdout).not.toContain("would stage Caddy binary")
      expect(await readFile(join(directory, "leo-caddy"), "utf8")).toBe("caddy-binary-fixture\n")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("uses explicit OIDC values over conflicting ambient variables while staging Caddy state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-prepare-apply-"))
    const currentAdminConfig = { running: "caddy-admin-config" }
    const adminRequests: { method: string; pathname: string }[] = []
    const adminServer = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        adminRequests.push({ method: request.method, pathname: url.pathname })
        if (url.pathname !== "/config/") return new Response("not found", { status: 404 })
        return Response.json(currentAdminConfig)
      },
    })
    try {
      const source = join(directory, "project-registry-source")
      const args = await preparationArguments(directory, {
        caddyAdminUrl: new URL("/config/", adminServer.url).toString(),
        includeLegacyBaseline: false,
        includeLiveOidc: true,
      })
      await mkdir(source, { recursive: true })
      await Bun.write(join(source, "package.json"), "{}\n")
      await mkdir(join(directory, "migrated-repository", "migrations"), { recursive: true })
      await Bun.write(join(directory, "migrated-repository", "migrations", "legacy-v1.json"), "{}\n")

      const fakeBin = join(directory, "bin")
      const fakeBun = join(fakeBin, "bun")
      const fakeSetcap = join(fakeBin, "setcap")
      const fakeGetcap = join(fakeBin, "getcap")
      const fakeInstall = join(fakeBin, "install")
      const fakeId = join(fakeBin, "id")
      const fakeGetent = join(fakeBin, "getent")
      const fakeChown = join(fakeBin, "chown")
      const installLog = join(directory, "install.log")
      await mkdir(fakeBin, { recursive: true })
      await Bun.write(
        fakeBun,
        `#!/bin/sh
set -eu
if [ "\$1" = "--version" ]; then
  printf '%s\\n' 'bun-fixture'
  exit 0
fi
[ "\$1" = "run" ]
case "\$2" in
  build:lib)
    mkdir -p dist node_modules
    printf '%s\\n' 'daemon-fixture' > dist/daemon.js
    printf '%s\\n' '{}' > node_modules/package.json
    ;;
  *caddy-candidate-generate.ts)
    output=''
    while [ "\$#" -gt 0 ]; do
      if [ "\$1" = "--output" ]; then output="\$2"; shift 2; else shift; fi
    done
    if [ "\$PROJECT_REGISTRY_OIDC_ISSUER" = 'https://auth.contentoren.de' ] && [ "\$PROJECT_REGISTRY_OIDC_PROVIDER" = 'zitadel' ] && [ "\$PROJECT_REGISTRY_OIDC_CLIENT_ID" = 'fixture-client-id' ] && [ "\$PROJECT_REGISTRY_OIDC_CLIENT_SECRET" = 'super-secret-client' ] && [ "\$PROJECT_REGISTRY_OIDC_COOKIE_SECRET" = 'super-secret-fixture' ]; then printf '%s\\n' matched > "\$OIDC_CANDIDATE_LOG"; else printf '%s\\n' mismatch > "\$OIDC_CANDIDATE_LOG"; exit 92; fi
     printf '%s\\n' '{}' > "\$output"
    ;;
  *caddy-admin-config-capture.ts)
    script="\$2"
    shift 2
    exec "\$REAL_BUN_BIN" run "\$script" "\$@"
    ;;
   *caddy-semantic-parity.ts)
      legacy=''
      caddy_bin=''
       while [ "\$#" -gt 0 ]; do
         case "\$1" in
           --legacy) legacy="\$2"; shift 2 ;;
           --caddy-bin) caddy_bin="\$2"; shift 2 ;;
           *) shift ;;
         esac
       done
       if [ "\$PROJECT_REGISTRY_OIDC_ISSUER" = 'https://auth.contentoren.de' ] && [ "\$PROJECT_REGISTRY_OIDC_PROVIDER" = 'zitadel' ] && [ "\$PROJECT_REGISTRY_OIDC_CLIENT_ID" = 'fixture-client-id' ] && [ "\$PROJECT_REGISTRY_OIDC_CLIENT_SECRET" = 'super-secret-client' ] && [ "\$PROJECT_REGISTRY_OIDC_COOKIE_SECRET" = 'super-secret-fixture' ]; then printf '%s\\n' matched > "\$OIDC_PARITY_LOG"; else printf '%s\\n' mismatch > "\$OIDC_PARITY_LOG"; exit 92; fi
       [ "\$caddy_bin" = "\$PRODUCTION_CADDY_BINARY" ]
      cp "\$legacy" "\$PARITY_BASELINE"
      ;;
   *caddy-dependency-preflight.ts)
      printf '%s\n' "\$@" > "\$PREFLIGHT_ARGS_LOG"
      ;;
  *)
    printf 'unexpected fake Bun command: %s\\n' "\$2" >&2
    exit 1
    ;;
esac
`,
      )
      await Bun.write(fakeSetcap, '#!/bin/sh\nprintf \'%s\\n\' "$2" >> "$SETCAP_CALLED"\n')
      await Bun.write(
        fakeGetcap,
        '#!/bin/sh\nprintf \'%s cap_net_bind_service=ep\\n\' "$1"\nprintf \'%s\\n\' "$1" > "$GETCAP_LOG"\n',
      )
      await Bun.write(
        fakeInstall,
        `#!/bin/bash
set -euo pipefail
printf '%s\n' "\$*" >> "\$INSTALL_LOG"
filtered=()
while ((\$# > 0)); do
  case "\$1" in
    -o|-g) shift 2 ;;
    *) filtered+=("\$1"); shift ;;
  esac
done
destination="\${filtered[\$((\${#filtered[@]} - 1))]}"
case "\$destination" in
  "\$OIDC_DESTINATION"|"\$OIDC_ALIAS_DESTINATION")
    backup_found=''
    for backup in "\$BACKUP_ROOT"/caddy-state-*; do
      if [ -f "\$backup/caddy-oidc.env" ] && [ -f "\$backup/caddy-oidc-alias.env" ]; then
        backup_found=1
        break
      fi
    done
    [ -n "\$backup_found" ] || { printf '%s\\n' 'OIDC destination write happened before backup' >&2; exit 91; }
    printf '%s\\n' "\$destination" >> "\$OIDC_WRITE_LOG"
    ;;
esac
exec /usr/bin/install "\${filtered[@]}"
`,
      )
       await Bun.write(
         fakeId,
         '#!/bin/sh\nif [ "$1" = "-u" ] && [ "$2" = "--" ]; then printf \'999\\n\'; elif [ "$1" = "-u" ]; then printf \'0\\n\'; else exit 0; fi\n',
       )
       await Bun.write(fakeGetent, "#!/bin/sh\nprintf '%s\\n' 'caddy:x:988:'\n")
      await Bun.write(fakeChown, "#!/bin/sh\nexit 0\n")
      await chmod(fakeBun, 0o755)
      await chmod(fakeSetcap, 0o755)
      await chmod(fakeGetcap, 0o755)
      await chmod(fakeInstall, 0o755)
      await chmod(fakeId, 0o755)
      await chmod(fakeGetent, 0o755)
      await chmod(fakeChown, 0o755)

      const liveData = join(directory, "live-caddy-data")
      const liveConfig = join(directory, "live-caddy", "caddy.json")
      const liveUnit = join(directory, "live-systemd", "caddy.service")
      const liveDataContents = await readFile(join(liveData, "certificates", "authoritative.json"), "utf8")
      const liveDestinationOnly = await readFile(join(liveData, "destination-only.json"), "utf8")
      const liveConfigContents = await readFile(liveConfig, "utf8")
      const liveUnitContents = await readFile(liveUnit, "utf8")
      const liveOidcDestination = join(directory, "system-caddy", "leonardomora.oidc.env")
      const liveOidcAliasDestination = join(directory, "system-caddy", "caddy-projects.oidc.env")
      const liveOidcContents = await readFile(liveOidcDestination, "utf8")
      const liveOidcAliasContents = await readFile(liveOidcAliasDestination, "utf8")
      const oidcWriteLog = join(directory, "oidc-writes.log")
      const backupRoot = join(directory, "caddy-backups")
      await mkdir(backupRoot, { recursive: true })
      await chmod(backupRoot, 0o755)
      await chmod(liveData, 0o755)
      await chmod(join(liveData, "certificates"), 0o755)
      await chmod(liveConfig, 0o644)
      await chmod(liveOidcDestination, 0o644)
      await chmod(liveOidcAliasDestination, 0o644)

      const environment = {
        ...(Bun.env as Record<string, string>),
        BUN_BIN: fakeBun,
        SETCAP_BIN: fakeSetcap,
        GETCAP_BIN: fakeGetcap,
        INSTALL_BIN: fakeInstall,
        PARITY_BASELINE: join(directory, "parity-baseline.json"),
        REAL_BUN_BIN: process.execPath,
        PRODUCTION_CADDY_BINARY: join(directory, "leo-caddy"),
        PROJECT_REGISTRY_BUN_RUNTIME_PATH: join(directory, "stable", "bun"),
        OIDC_DESTINATION: liveOidcDestination,
        OIDC_ALIAS_DESTINATION: liveOidcAliasDestination,
        BACKUP_ROOT: join(directory, "caddy-backups"),
        OIDC_WRITE_LOG: oidcWriteLog,
        INSTALL_LOG: installLog,
        SETCAP_CALLED: join(directory, "setcap-called"),
        GETCAP_LOG: join(directory, "getcap.log"),
        PREFLIGHT_ARGS_LOG: join(directory, "dependency-preflight-args.log"),
        OIDC_CANDIDATE_LOG: join(directory, "oidc-candidate.log"),
        OIDC_PARITY_LOG: join(directory, "oidc-parity.log"),
        PATH: `${fakeBin}:${Bun.env.PATH ?? ""}`,
        CADDY_SERVICE_IDENTITY_FILE: caddyIdentityFixture,
      }
      Object.assign(environment, {
        PROJECT_REGISTRY_OIDC_ISSUER: "ambient-project-registry-issuer",
        PROJECT_REGISTRY_OIDC_PROVIDER: "ambient-project-registry-provider",
        PROJECT_REGISTRY_OIDC_CLIENT_ID: "ambient-project-registry-client-id",
        PROJECT_REGISTRY_OIDC_CLIENT_SECRET: "ambient-project-registry-client-secret",
        PROJECT_REGISTRY_OIDC_COOKIE_SECRET: "ambient-project-registry-cookie-secret",
        CADDY_PROJECTS_OIDC_ISSUER: "ambient-caddy-projects-issuer",
        CADDY_PROJECTS_OIDC_PROVIDER: "ambient-caddy-projects-provider",
        CADDY_PROJECTS_OIDC_CLIENT_ID: "ambient-caddy-projects-client-id",
        CADDY_PROJECTS_OIDC_CLIENT_SECRET: "ambient-caddy-projects-client-secret",
        CADDY_PROJECTS_OIDC_COOKIE_SECRET: "ambient-caddy-projects-cookie-secret",
        LEONARDOMORA_OIDC_ISSUER: "ambient-leonardomora-issuer",
        LEONARDOMORA_OIDC_PROVIDER: "ambient-leonardomora-provider",
        LEONARDOMORA_OIDC_CLIENT_ID: "ambient-leonardomora-client-id",
        LEONARDOMORA_OIDC_CLIENT_SECRET: "ambient-leonardomora-client-secret",
        COOKIE_SECRET: "ambient-cookie-secret",
      })
      const result = await command("bash", [preparationScript, "--apply", ...args], environment)

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("created Caddy state backup:")
      expect(await readFile(join(liveData, "certificates", "authoritative.json"), "utf8")).toBe(liveDataContents)
      expect(await readFile(join(liveData, "destination-only.json"), "utf8")).toBe(liveDestinationOnly)
      expect(await readFile(liveConfig, "utf8")).toBe(liveConfigContents)
      expect(await readFile(liveUnit, "utf8")).toBe(liveUnitContents)
      expect(await readFile(liveOidcDestination, "utf8")).not.toBe(liveOidcContents)
      expect(await readFile(liveOidcAliasDestination, "utf8")).not.toBe(liveOidcAliasContents)
      expect(result.stdout).not.toContain("super-secret-client")
      expect(result.stdout).not.toContain("super-secret-fixture")
      expect(result.stderr).not.toContain("super-secret-client")
      expect(result.stderr).not.toContain("super-secret-fixture")
      expect(await readFile(join(directory, "system-caddy", "caddy"), "utf8")).toBe("caddy-binary-fixture\n")
      expect(await readFile(join(directory, "setcap-called"), "utf8")).toBe(
        `${join(directory, "system-caddy", "caddy")}\n`,
      )
      expect(await readFile(join(directory, "caddy-staging", "caddy.json"), "utf8")).toBe("{}\n")
      const installCommands = (await readFile(installLog, "utf8")).trim().split("\n")
      const caddyOwnedInstallCommands = installCommands.filter((command) => command.includes("-o nobody -g nogroup"))
      expect(caddyOwnedInstallCommands).toHaveLength(7)
      expect(installCommands.some((command) => command.includes("-o caddy -g caddy"))).toBe(false)
      expect(caddyOwnedInstallCommands.every((command) => !command.includes("caddy:caddy"))).toBe(true)
      expect(await readFile(environment.OIDC_CANDIDATE_LOG, "utf8")).toBe("matched\n")
      expect(await readFile(environment.OIDC_PARITY_LOG, "utf8")).toBe("matched\n")
      const installedOidc = await readFile(join(directory, "project-registry-config", "leonardomora.oidc.env"), "utf8")
      expect(installedOidc).toContain("PROJECT_REGISTRY_OIDC_ISSUER=https://auth.contentoren.de\n")
      expect(installedOidc).toContain("PROJECT_REGISTRY_OIDC_PROVIDER=zitadel\n")
      expect(installedOidc).toContain("PROJECT_REGISTRY_OIDC_CLIENT_ID=fixture-client-id\n")
      expect(installedOidc).toContain("PROJECT_REGISTRY_OIDC_CLIENT_SECRET=super-secret-client\n")
      expect(installedOidc).toContain("PROJECT_REGISTRY_OIDC_COOKIE_SECRET=super-secret-fixture\n")
      expect(installedOidc).not.toContain("ambient-")
      expect(await readFile(join(directory, "caddy-staging", "caddy.service"), "utf8")).toBe(
        await readFile(caddyUnitFixture, "utf8"),
      )
      const firstBackupNames = await readdir(backupRoot)
      expect(firstBackupNames).toHaveLength(1)
      const firstBackup = join(backupRoot, firstBackupNames[0]!)
      expect(firstBackupNames[0]).toMatch(/^caddy-state-\d{8}T\d{6}Z(?:-\d+)?$/)
      expect(await readFile(join(firstBackup, "caddy-data", "certificates", "authoritative.json"), "utf8")).toBe(
        liveDataContents,
      )
      expect(await readFile(join(firstBackup, "caddy-data", "destination-only.json"), "utf8")).toBe(liveDestinationOnly)
      expect(await readFile(join(firstBackup, "caddy.json"), "utf8")).toBe(liveConfigContents)
      expect(await readFile(join(firstBackup, "caddy.service"), "utf8")).toBe(liveUnitContents)
      expect(await readFile(join(firstBackup, "caddy-oidc.env"), "utf8")).toBe(liveOidcContents)
      expect(await readFile(join(firstBackup, "caddy-oidc-alias.env"), "utf8")).toBe(liveOidcAliasContents)
      expect((await stat(backupRoot)).mode & 0o777).toBe(0o700)
      expect((await stat(join(firstBackup, "caddy-data"))).mode & 0o777).toBe(0o700)
      expect((await stat(join(firstBackup, "caddy-data", "certificates"))).mode & 0o777).toBe(0o700)
      expect((await stat(firstBackup)).mode & 0o777).toBe(0o700)
      expect((await stat(join(firstBackup, "caddy.json"))).mode & 0o777).toBe(0o600)
      expect((await stat(join(firstBackup, "caddy-oidc.env"))).mode & 0o777).toBe(0o600)
      expect((await stat(join(firstBackup, "caddy-oidc-alias.env"))).mode & 0o777).toBe(0o600)
      expect((await readFile(oidcWriteLog, "utf8")).trim().split("\n")).toEqual([
        liveOidcDestination,
        liveOidcAliasDestination,
      ])
      expect(await readFile(join(firstBackup, "caddy-admin-config.json"), "utf8")).toBe(
        `${JSON.stringify(currentAdminConfig, null, 2)}\n`,
      )
      expect((await stat(join(firstBackup, "caddy-admin-config.json"))).mode & 0o777).toBe(0o600)
      expect(await readFile(environment.PARITY_BASELINE, "utf8")).toBe(
        `${JSON.stringify(currentAdminConfig, null, 2)}\n`,
      )
       const preflightArguments = await readFile(environment.PREFLIGHT_ARGS_LOG, "utf8")
       expect(preflightArguments).toContain("--allow-missing-backends\n")
       expect(preflightArguments).toContain("--allow-missing-filesystem\n")
       expect(preflightArguments).toContain("--caddy-user\nnobody\n")
       expect(preflightArguments).toContain("--caddy-group\nnogroup\n")
      expect(preflightArguments).toContain("--caddy-working-directory\n/home/caddy\n")
      expect(preflightArguments).toContain("--caddy-access-command\n/usr/sbin/runuser\n")
      expect(adminRequests).toEqual([{ method: "GET", pathname: "/config/" }])

      const sameBinaryArgs = [...args]
      sameBinaryArgs[sameBinaryArgs.indexOf("--caddy-binary-destination") + 1] = join(directory, "leo-caddy")
      const secondResult = await command("bash", [preparationScript, "--apply", ...sameBinaryArgs], environment)
      expect(secondResult.exitCode).toBe(0)
      const secondBackupNames = await readdir(backupRoot)
      expect(secondBackupNames).toHaveLength(2)
      expect(new Set(secondBackupNames).size).toBe(2)
      expect(secondBackupNames).not.toEqual(firstBackupNames)
      const secondBackup = join(backupRoot, secondBackupNames.find((name) => name !== firstBackupNames[0])!)
      expect((await stat(secondBackup)).mode & 0o777).toBe(0o700)
      expect(await readFile(join(secondBackup, "caddy-oidc.env"), "utf8")).not.toBe(liveOidcContents)
      expect(await readFile(join(directory, "setcap-called"), "utf8")).toBe(
        `${join(directory, "system-caddy", "caddy")}\n`,
      )
      expect(await readFile(join(directory, "getcap.log"), "utf8")).toBe(`${join(directory, "leo-caddy")}\n`)

      const replacementSource = join(directory, "replacement-caddy")
      await Bun.write(replacementSource, "replacement-caddy-fixture\n")
      await chmod(replacementSource, 0o755)
      const replacementArgs = [...sameBinaryArgs]
      replacementArgs[replacementArgs.indexOf("--caddy-binary-source") + 1] = replacementSource
      const refusalResult = await command("bash", [preparationScript, "--apply", ...replacementArgs], environment)
      expect(refusalResult.exitCode).toBe(1)
      expect(refusalResult.stderr).toContain("Caddy replacement is outside this daemon migration")
      expect(await readdir(backupRoot)).toHaveLength(2)
    } finally {
      adminServer.stop()
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("does not install or stage anything when parity fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-prepare-parity-failure-"))
    try {
      const source = join(directory, "project-registry-source")
      const args = await preparationArguments(directory, { includeLiveOidc: true })
      await mkdir(source, { recursive: true })
      await Bun.write(join(source, "package.json"), "{}\n")
      await mkdir(join(directory, "migrated-repository", "migrations"), { recursive: true })
      await Bun.write(join(directory, "migrated-repository", "migrations", "legacy-v1.json"), "{}\n")

      const fakeBin = join(directory, "bin")
      const fakeBun = join(fakeBin, "bun")
      const fakeSetcap = join(fakeBin, "setcap")
      const fakeId = join(fakeBin, "id")
      const fakeGetent = join(fakeBin, "getent")
      await mkdir(fakeBin, { recursive: true })
      await Bun.write(
        fakeBun,
        `#!/bin/sh
set -eu
[ "\$1" = "run" ]
case "\$2" in
  *caddy-candidate-generate.ts)
    output=''
    while [ "\$#" -gt 0 ]; do
      if [ "\$1" = "--output" ]; then output="\$2"; shift 2; else shift; fi
    done
    printf '%s\\n' '{}' > "\$output"
    ;;
  *caddy-semantic-parity.ts)
    exit 23
    ;;
  *)
    printf 'unexpected fake Bun command: %s\\n' "\$2" >&2
    exit 1
    ;;
esac
`,
      )
      await Bun.write(fakeSetcap, "#!/bin/sh\nexit 0\n")
       await Bun.write(
         fakeId,
         '#!/bin/sh\nif [ "$1" = "-u" ] && [ "$2" = "--" ]; then printf \'999\\n\'; elif [ "$1" = "-u" ]; then printf \'0\\n\'; else exit 0; fi\n',
       )
       await Bun.write(fakeGetent, "#!/bin/sh\nprintf '%s\\n' 'caddy:x:988:'\n")
      await chmod(fakeBun, 0o755)
      await chmod(fakeSetcap, 0o755)
      await chmod(fakeId, 0o755)
      await chmod(fakeGetent, 0o755)

      const liveOidcDestination = join(directory, "system-caddy", "leonardomora.oidc.env")
      const liveOidcAliasDestination = join(directory, "system-caddy", "caddy-projects.oidc.env")
      const liveOidcContents = await readFile(liveOidcDestination, "utf8")
      const liveOidcAliasContents = await readFile(liveOidcAliasDestination, "utf8")

      const result = await command("bash", [preparationScript, "--apply", ...args], {
        ...(Bun.env as Record<string, string>),
        BUN_BIN: fakeBun,
        SETCAP_BIN: fakeSetcap,
        PATH: `${fakeBin}:${Bun.env.PATH ?? ""}`,
      })

      expect(result.exitCode).toBe(23)
      expect(await exists(join(directory, "caddy-backups"))).toBe(false)
      expect(await exists(join(directory, "caddy-staging"))).toBe(false)
      expect(await exists(join(directory, "candidate.json"))).toBe(false)
      expect(await readFile(liveOidcDestination, "utf8")).toBe(liveOidcContents)
      expect(await readFile(liveOidcAliasDestination, "utf8")).toBe(liveOidcAliasContents)
      expect(await exists(join(directory, "project-registry-install"))).toBe(false)
      expect(await exists(join(directory, "project-registry-config"))).toBe(false)
      expect(await exists(join(directory, "systemd"))).toBe(false)
      expect(await exists(join(source, "dist"))).toBe(false)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("requires an explicit apply mode rather than accepting both modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-registry-prepare-arguments-"))
    try {
      const result = await command(
        "bash",
        [preparationScript, "--dry-run", "--apply"],
        Bun.env as Record<string, string>,
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("mutually exclusive")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("does not embed service control or admin API load commands", async () => {
    const script = await readFile(preparationScript, "utf8")

     expect(script).not.toMatch(/\bsystemctl\s+(start|enable|restart|stop|reload|daemon-reload)\b/)
    expect(script).not.toMatch(/\bcurl\b/)
    expect(script).not.toMatch(/\/load\b/)
    expect(script).not.toMatch(/caddy\s+(run|reload|stop)\b/)
    expect(script).not.toMatch(/\brsync\b/)
    expect(script).not.toContain("--delete")
    expect(script).toContain("backup_live_caddy_state")
    expect(script).toContain('"$CADDY_CONFIG_STAGE"')
    expect(script).toContain('"$CADDY_UNIT_STAGE"')
    expect(script).toContain('--caddy-user "$CADDY_USER"')
    expect(script).toContain('"$CADDY_ACCESS_COMMAND" -u "$CADDY_USER" -g "$CADDY_GROUP" -- test -r')
    expect(script).toContain('"$CADDY_ACCESS_COMMAND" -u "$CADDY_USER" -g "$CADDY_GROUP" -- test -x')
    expect(script).toContain('"$CADDY_ACCESS_COMMAND" -u "$CADDY_USER" -g "$CADDY_GROUP" -- test -w')
    expect(script).not.toContain('install -o caddy -g caddy')
    expect(script).toContain('--caddy-access-command "$CADDY_ACCESS_COMMAND"')
     expect(script).toContain("stage_caddy_unit_unchanged")
    expect(script).not.toContain("caddy_umask")
    expect(script).not.toContain("caddy_access_log_audit")
    expect(script).toContain("access_log_root_preflight")
  })

  test("normalizes OIDC values in memory before the installer runs", async () => {
    const script = await readFile(preparationScript, "utf8")

    expect(script).toContain("load_project_registry_oidc_environment")
    expect(script).toContain('source "$OIDC_SOURCE"')
    expect(script).toContain('"$PROJECT_REGISTRY_CONFIG_ROOT/leonardomora.oidc.env" "$CADDY_OIDC_ALIAS_DESTINATION"')
    expect(script).not.toContain("prepare_oidc_environment")
    expect(script).toContain("LEONARDOMORA_OIDC_CLIENT_ID")
    expect(script).toContain("COOKIE_SECRET")
  })

  test("wires candidate generation and project-registryd to the migrated repository", async () => {
    const script = await readFile(preparationScript, "utf8")

    expect(script).toContain('--destination-repository "$MIGRATED_REPOSITORY"')
    expect(script).toContain('--repository "$MIGRATED_REPOSITORY"')
    expect(script).toContain('PROJECT_REGISTRY_REPOSITORY_PATH="$MIGRATED_REPOSITORY"')
    expect(script).not.toContain('--repository "$LEGACY_REPOSITORY" \\')
  })
})
