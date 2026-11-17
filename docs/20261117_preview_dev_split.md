# Preview/dev split

The `*.wonder1.de` preview and `project-registry dev up` servers are separate
deployments that must never share a port, domain, or env file.

## Preview: production build on the managed service

- The preview is a registry-managed system unit, `proj-<project>-<service>.service`,
  rendered by `src/managed-service/managedServiceUnitRender.ts`.
- It runs `bun run preview:start` (a production server on `$HOST:$PORT`) with the
  service env file `.env.preview`, which holds the preview (production-build) values.
- Refresh after merging: `bun run preview:deploy` builds the production bundle and
  restarts the unit via `project-registry svc restart <project> --service <service>`.
- Disabled routes are not served by Caddy (`src/caddy/caddyConfigGenerate.ts`
  skips them), but they still own their port: `projectPortNext`,
  the sibling allocator in `projectCanonicalNormalize`, and `devPortAllocate` all
  reserve disabled-owned ports, so re-enabling a route can never collide with a
  port handed out while it was disabled.

## Dev: leased port and domain via `dev up`

- `project-registry dev up <project>` leases its own port (pool 3000–3999, skipping
  registry row ports, other lease ports, and disabled-owned ports) and domain
  `<user>-<project>.wonder1.de`, with `PORT` and `HOST` set.
- The Vite dev server reads `PORT`/`HOST` from env, and `.env.development` is the
  dev server's own file — a copy of `.env.preview` with dev origins, ports, and
  domains. Dev tooling, `dev` scripts, CLIs, and tests keep reading it.
- Never run `bun run dev` on the preview port by hand; many Vite configs hardcode
  the preview port with `strictPort`, which collides instead of failing over.
