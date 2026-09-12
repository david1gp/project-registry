# Multi-service projects

## Goal

Allow one owner/project identity to contain multiple independently routed services, each preserving its own domains, port, and Caddy behavior, without losing existing registry data.

## Decisions

- Keep `(owner, name)` as project identity.
- Replace the single project-level Caddy deployment with project-owned services carrying stable IDs and the existing Caddy fields.
- Preserve labels and other project metadata at project level.
- Enforce domain and port uniqueness across active services, including services in the same project.
- Read and migrate existing project files losslessly; write only the new canonical structure.
- Group only explicitly mapped Leo records; group `sales-api`, `sales-web-preview`, and `sales-web-prod`
  under `sales`, `billing-preview` under `billing`, `coachingcompany-api` under `coachingcompany`, and
  `crm-api-preview` and `crm-convex-preview` under `crm`, plus `akademie-api`, `akademie-dev-api`, and
  `akademie-prod` under the `Eigene`-section project `akademie`, while preserving their service IDs and existing Caddy
  settings. CRM's external preview routing remains external while the parent retains its internal Caddy access.
- Keep Git history as rollback; migration changes are validated before activation.

## Approach

- Extend domain schemas and APIs around a service collection while preserving current Caddy semantics.
- Adapt collision checks, port allocation, persistence, and Caddy generation to iterate services.
- Add a deterministic repository migration for legacy records and explicit Leo grouping mappings.
- Update CLI/UI consumers and tests to display and edit services under one project.
- Current context: implementation and verification are complete. Canonical version 2 services are `{ id, units, caddy }`; legacy records parse compatibly and canonical writes preserve metadata. CRUD, persistence, collision/allocation, per-service Caddy routes, CLI, and UI support multiple services. The atomic migration maps Leo's emailoutreach, allgroups-chat, coachingcompany, CRM, sales, and billing service records, and has not been applied to external data.

## Tasks

- [x] 1. Define the service model and backward-compatible parsing/migration boundary with focused schema tests.
- [x] 2. Update project create/edit/get/list behavior and persistence to use canonical services.
- [x] 3. Update collision validation and automatic port allocation across project services.
- [x] 4. Generate Caddy routes per service while preserving existing route behavior.
- [x] 5. Add the explicit data migration/grouping operation and cover rollback-safe, lossless behavior.
- [x] 6. Update UI/CLI consumers to manage and present multiple services per project.
- [x] 7. Run focused and full verification, including migrated Leo fixtures and generated configuration.
