# Project labels

## Goal

Add safe free-form project labels as a string record, persisted and exposed by the versioned API and manageable through the CLI.

## Decisions

- Store canonical `labels` at project top level as `Record<string, string>`, defaulting to `{}`.
- Preserve arbitrary own string keys safely, including reserved JavaScript property names; reject non-string values and blank keys.
- Treat an API edit containing `labels` as complete label-map replacement, while edits without `labels` preserve existing labels.
- CLI create/edit accepts repeatable `--label KEY=VALUE`; edit also accepts repeatable `--remove-label KEY` and `--clear-labels`.
- CLI edit computes the resulting complete map from the current project before sending it, so additions, updates, removals, and clearing are supported.
- Existing human list/get output stays compatible; labels are available in JSON output. Legacy API shapes remain unchanged.
- UI grouping/rendering is outside this change.

## Approach

- Reuse the safe string-record schema/copying pattern used by Caddy header maps.
- Extend project input, canonical schema, and normalization.
- Special-case label replacement in project edit merging.
- Extend CLI invocation parsing, help, request creation, and focused tests.
- Verify schema, normalization, use-case, API, and CLI behavior with test concurrency limited to one, then run typecheck.

## Tasks

- [x] 1. Add the labels schema, normalization, and project edit replacement semantics with focused domain tests.
- [x] 2. Verify labels round-trip through versioned create/edit/get/list API behavior and add focused API coverage.
- [x] 3. Add CLI create/edit label options, removal/clear behavior, help, and JSON read coverage.
- [x] 4. Run focused tests and typecheck; fix only label-related regressions.

## Paths

- `src/project/projectSchema.ts`
- `src/project/projectInputSchema.ts`
- `src/project/projectNormalize.ts`
- `src/project/projectEdit.ts`
- `src/project/projectSchema.test.ts`
- `src/project/projectNormalize.test.ts`
- `src/project/projectUseCases.test.ts`
- `src/api/projectRegistryApiHandlerCreate.test.ts`
- `src/cli/ProjectRegistryCliInvocation.ts`
- `src/cli/projectRegistryCliArgumentsParse.ts`
- `src/cli/projectRegistryCliArgumentsParse.test.ts`
- `src/cli/projectRegistryCliHelp.ts`
- `src/cli/projectRegistryCliRun.ts`
- `src/cli/projectRegistryCliRun.test.ts`
