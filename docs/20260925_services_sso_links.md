# Services dashboard SSO links

## Goal
On leo@leo-server, add preview and production SSO links for semesterkur-v2, coachingcompany-v2, filmschauspielschule-v2, crm, eventoren, allgroups-chat, archive, multichat. Display link.* labels without their prefix, including renamed link.official and link.production. Commit using a Luna agent and commits skill, deploy, and verify the deployed dashboard.

## Scope and decisions
- Services checkout: /home/leo/projects/services. Read its instructions. Registry is authoritative; preserve unrelated metadata and service routes.
- /sso is a frontend-relative path. Store link.prev-sso=/sso and link.prod-sso=/sso. Resolve relative link.<base>-<suffix> against the named base link (prev or prod). Preserve absolute links; never change service domains. Add explicit link.prev/link.prod bases only where necessary to represent the intended origins below. Use existing preview/production aliases where appropriate, with explicit named bases taking precedence.
- Origins (preview / production): semesterkur-v2: semesterkur.leonardomora.de / semesterkur.contentoren.de; coachingcompany-v2: coachingcompany-v2.leonardomora.de / coachingcompany.contentoren.de; filmschauspielschule-v2: preview.filmschauspielschule-v2.leonardomora.de / filmschauspielschule.contentoren.de; crm: preview.crm.contentoren.de / crm.contentoren.de; eventoren: eventoren.leonardomora.de / eventoren.de; allgroups-chat: preview.allgroups.chat / allgroups.chat; archive: archive.leonardomora.de / archive.contentoren.de; multichat: multichat.leonardomora.de / multichat.contentoren.de. All HTTPS, append /sso.
- Multichat has no established /sso route; adding that application route is outside scope. Do not claim endpoint functionality based on SPA HTTP 200.
- Existing generic link rendering should remain. Normalize bare hostnames for link.production so existing values display. Update favicon usage to link.official with legacy fallback if appropriate. Inspect other old-key references for required fixes only.
- Reuse existing libraries; do not change library UI copies. No broad redesign or application SSO implementation.

## Tasks
1. Implement minimal services UI/model changes, relative named-base resolution, and focused regression tests; verify tests with maximum concurrency 1. Status: completed.
2. Set relative SSO labels and required explicit bases on all eight projects, preserving all unrelated fields. Status: completed.
3. Luna agent loads commits skill, commits and pushes scoped services changes including the authenticated loading-state fix, then runs documented deployment. Status: completed.
4. Browser agent checks deployed cards, label text and exact hrefs for all eight projects and renamed official/production links. Status: completed.

## Verification
Run only relevant model/favicon tests, no watch mode, maximum concurrency 1; after failure rerun only failing tests. Run applicable build/type checks without broad unrelated repairs. Compare live registry before/after. Browser verification targets the authenticated deployed services UI and actual anchors; do not claim SSO authentication flows tested.

## Current context
Renamed-label changes, relative-link resolution and the homePageStateCreate jobsVisited accessor fix are committed, pushed and deployed at https://services.contentoren.de.
Relative SSO labels and necessary explicit bases are set on all eight projects. The deployed registry uses shared project labels across service records. Access services files through ssh leo@leo-server, not local filesystem paths.
