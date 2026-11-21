# Rootless container managed services

## Problem

Managed services render a hardened system unit (`User=projects`,
`NoNewPrivileges=yes`, `ProtectHome=tmpfs`). Rootless Podman cannot start
there: `ProtectHome=tmpfs` hides `/run/user/<uid>` (podman runroot, pause
process, netns), and `NoNewPrivileges` stops the setuid `newuidmap` helper
("write to uid_map failed: Operation not permitted"). Container workloads
(google-maps-scraper) therefore ran in a personal `systemctl --user` manager
that the other members of group `projects` could not operate.

## Design

`service.container: "podman"` on a registry row (CLI `--service-container
podman`, cleared with `--clear-service-container`) marks the managed command as
a `podman run …` invocation. The command stays the row's argv (`{port}`
placeholder, no shell); the schema requires an explicit command for container
rows.

The reconciler resolves the service user's uid from `/etc/passwd` and renders,
for container rows only:

- `Requires=`/`After=user-runtime-dir@<uid>.service`
- `Type=notify`, `NotifyAccess=all`, `Delegate=yes`, `KillMode=mixed`,
  `TimeoutStopSec=60`
- `Environment=XDG_RUNTIME_DIR=/run/user/<uid>`
- `ExecStart=podman --root <home>/.local/share/containers/storage --runroot
  /run/user/<uid>/containers run --rm --replace --name proj-<project>-<service>
  --cgroups=split --sdnotify=conmon --detach --log-driver=passthrough
  --umask=0002 <row args>`
- `ExecStop=podman … stop --ignore --time 30 <name>`,
  `ExecStopPost=-podman … rm --force --ignore <name>`
- no `NoNewPrivileges`; `BindPaths=<home> /run/user/<uid>` and that runtime
  dir added to `ReadWritePaths`

Everything else (`ProtectSystem=strict`, `ProtectHome=tmpfs`, `PrivateTmp`,
`InaccessiblePaths=-/servers`, slice, `UMask=0002`) is unchanged. The explicit
`--root`/`--runroot` flags matter: as uid 994 podman otherwise falls back to the
root-owned `/run/containers/storage` defaults.

Row arguments may not set options the unit owns (`--name`, `--replace`,
`--rm`, `-d/--detach`, `--cgroups`, `--sdnotify`, `--log-driver`, `--umask`,
`--root`, `--runroot`, `--pod`); the check is token-exact and also applies after
the image, so an entrypoint flag with the same spelling is refused.

Permissions are unchanged: `svc status|start|stop|restart|logs` go through the
daemon, which runs `systemctl`/`journalctl` as root after the normal
managed-service authorization, so every allowed member can operate the unit.

## Host prerequisites

- subuid/subgid ranges for the service user (`projects: 493216:65536`)
- `loginctl enable-linger projects`
- images loaded or built into the service user's store, e.g.
  `podman --root /home/projects/.local/share/containers/storage --runroot
  /run/user/994/containers images`

## Verified

Prototype unit on wonder1-server (podman 6.1.3, runc, pasta, cgroup v2): the
container payload and conmon run inside `/projects.slice/<unit>`, logs appear in
`journalctl -u <unit>`, restart and stop are clean (~1s) and leave no container.
