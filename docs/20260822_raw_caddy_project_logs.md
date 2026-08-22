# Raw Caddy project logs

## Goal

Expose complete, unmodified per-project Caddy JSON access records to authorized project consumers through the existing API, CLI, and UI, while simplifying deployment permission setup for the trusted internal environment.

## Decisions

- Caddy stores complete records, including query strings, request and response headers, cookies, authorization values, and full client IP addresses.
- The API returns the complete Caddy JSON object for each record rather than the current privacy-filtered field projection.
- Existing per-project authorization and logger separation remain.
- Existing pagination, file and decompression bounds, path/symlink protections, rotation detection, and Caddy retention remain as operational correctness controls.
- CLI JSON output emits complete records; human output presents each record without silently discarding fields.
- The UI provides an inspectable raw JSON representation for every record.
- Keep the minimum functional Caddy-owned log directory permissions; remove strict installer permission auditing/repair and the custom Caddy umask drop-in.
- Cursor HMAC signing is unnecessary for trusted internal callers. Keep cursors opaque and versioned, with strict
  structural validation, expiry, requested-project binding, source fingerprint and anchor validation, and deterministic
  offset-based paging.

## Approach

- Remove Caddy encoder transformations and enable credential-bearing fields in the per-project logger.
- Replace the access-log record projection with a bounded JSON-value model that preserves every parsed field.
- Propagate the raw record shape through source, API, CLI, and UI boundaries without adding a second endpoint or compatibility layer.
- Simplify installation around basic directory creation and ownership while retaining permissions needed for Caddy rotation and daemon reads.
- Update focused tests, fixtures, documentation, and end-to-end coverage around the new raw-record contract.

## Tasks

- [x] 1. Change generated Caddy project log configuration to write unmodified records and update configuration tests/snapshots.
- [x] 2. Replace the filtered parser/domain record with bounded raw JSON records; update source, cursor interaction, API contract, and tests.
- [x] 3. Update CLI parsing and human/JSON formatting to preserve and display complete records; update integration tests.
- [x] 4. Update the project access-log UI schema and views to inspect complete raw JSON records; verify behavior in a browser.
- [x] 5. Simplify access-log provisioning to minimum functional ownership/modes and remove strict auditing and custom umask setup; update operations tests and documentation.
- [x] 6. Review cursor signing complexity and remove it only if validation/source binding remain correct; update cursor tests and documentation.
- [x] 7. Run focused and full verification, including real-Caddy coverage where available, and update the original implementation document to match the raw internal-log architecture.

## Paths

- `src/caddy/`
- `src/access-log/`
- `src/api/`
- `src/cli/`
- `src/ui/project/`
- `ops/migration/`
- `test/fixtures/`
- `docs/20260821_caddy_project_logs.md`
- `docs/20260822_raw_caddy_project_logs.md`
