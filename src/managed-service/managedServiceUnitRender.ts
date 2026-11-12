import { isAbsolute } from "node:path"
import { createResult, createResultError, type Result } from "#result"
import type { ManagedServiceUnitSpec } from "./ManagedServiceUnitSpec.js"
import { managedServiceUnitMarker } from "./managedServiceUnitMarker.js"

// Values reach systemd unit syntax, not a shell. Everything rendered is
// restricted to characters that need no quoting beyond `%` specifier
// escaping; anything else fails the render instead of being escaped.
const valuePattern = /^[A-Za-z0-9_./:+=,@%-]+$/
const bareCommandPattern = /^[A-Za-z0-9_.+-]+$/
const identityPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const slicePattern = /^[A-Za-z0-9_.-]+\.slice$/

function specifierEscape(value: string): string {
  return value.replaceAll("%", "%%")
}

function absolutePathIsSafe(value: string): boolean {
  return isAbsolute(value) && valuePattern.test(value) && !value.split("/").includes("..")
}

/**
 * Render a registry-owned system unit for one managed project service. Pure:
 * no filesystem or systemd access. The unit runs as the unprivileged service
 * user in its own slice with the registry row's port; `/servers` and every
 * home except the service user's own stay invisible, and only the projects
 * root plus that home are writable.
 */
export function managedServiceUnitRender(spec: ManagedServiceUnitSpec): Result<string> {
  const op = "managedServiceUnitRender"
  if (!identityPattern.test(spec.user) || !identityPattern.test(spec.group)) {
    return createResultError(op, "service user or group is invalid")
  }
  if (!slicePattern.test(spec.slice)) return createResultError(op, "service slice is invalid")
  if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
    return createResultError(op, "service port is invalid")
  }
  for (const path of [spec.homeDirectory, spec.projectsRoot, spec.workingDirectory]) {
    if (!absolutePathIsSafe(path)) return createResultError(op, `path ${path} is invalid`)
  }
  if (spec.envFile !== undefined && !absolutePathIsSafe(spec.envFile)) {
    return createResultError(op, "service env file path is invalid")
  }
  if (!spec.pathValue.split(":").every(absolutePathIsSafe)) return createResultError(op, "service PATH is invalid")
  if (spec.domains.some((domain) => !/^[a-z0-9.*-]+$/.test(domain))) {
    return createResultError(op, "service domains are invalid")
  }
  if (!spec.args.every((arg) => valuePattern.test(arg))) return createResultError(op, "service arguments are invalid")
  // systemd's own search path ignores Environment=PATH, so bare names run
  // through /usr/bin/env to pick up the configured toolchain PATH.
  let executable: string[]
  if (absolutePathIsSafe(spec.command)) executable = [spec.command]
  else if (bareCommandPattern.test(spec.command)) executable = ["/usr/bin/env", spec.command]
  else return createResultError(op, "service command must be absolute or a bare executable name")

  const home = spec.homeDirectory
  const homeUnderHome = home === "/home" || home.startsWith("/home/")
  const environment = [
    `PATH=${spec.pathValue}`,
    `HOME=${home}`,
    `PORT=${spec.port}`,
    "HOST=127.0.0.1",
    ...(spec.domains.length === 0 ? [] : [`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${spec.domains.join(",")}`]),
  ]
  const lines = [
    managedServiceUnitMarker,
    `# project-registry-key: ${spec.owner}/${spec.project}/${spec.service}`,
    "[Unit]",
    `Description=project-registry managed service ${spec.owner}/${spec.project} ${spec.service}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${spec.user}`,
    `Group=${spec.group}`,
    `WorkingDirectory=${specifierEscape(spec.workingDirectory)}`,
    "UMask=0002",
    ...environment.map((entry) => `Environment=${specifierEscape(entry)}`),
    ...(spec.envFile === undefined ? [] : [`EnvironmentFile=-${specifierEscape(spec.envFile)}`]),
    `ExecStart=${[...executable, ...spec.args].map(specifierEscape).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    `Slice=${spec.slice}`,
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=tmpfs",
    ...(homeUnderHome ? [`BindPaths=${specifierEscape(home)}`] : []),
    `ReadWritePaths=${specifierEscape(spec.projectsRoot)} ${specifierEscape(home)}`,
    "InaccessiblePaths=-/servers",
    "PrivateTmp=yes",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ]
  return createResult(lines.join("\n"))
}
