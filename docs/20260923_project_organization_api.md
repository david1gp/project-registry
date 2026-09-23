# Project organization API

`POST /api/v1/users/{owner}/projects/organization` applies one atomic, revision-checked project organization operation. It requires the same authenticated project-owner access as other versioned project routes. Every project key, including merge entry references, must use the path owner; section renames affect matching sections only for that owner.

Request body is `{ "expectedRevision": "<current registry revision>", "operation": ... }`:

```json
{"expectedRevision":"<revision>","operation":{"action":"merge","target":{"owner":"alice","name":"app"},"sources":[{"owner":"alice","name":"api"}],"targetDisplayName":"Application","entries":[{"project":{"owner":"alice","name":"app"},"serviceId":"web","displayName":"Website","order":0},{"project":{"owner":"alice","name":"api"},"serviceId":"default","order":1}]}}
{"expectedRevision":"<revision>","operation":{"action":"displayEdit","projects":[{"key":{"owner":"alice","name":"app"},"displayName":"Application","services":[{"id":"web","displayName":"Website","order":0},{"id":"worker","order":1}]},{"key":{"owner":"alice","name":"api"},"services":[{"id":"default","displayName":"API","order":0}]}]}}
{"expectedRevision":"<revision>","operation":{"action":"split","source":{"owner":"alice","name":"app"},"serviceId":"api","target":{"owner":"alice","name":"api"},"targetDisplayName":"API"}}
{"expectedRevision":"<revision>","operation":{"action":"sectionRename","section":"tools","displayName":"Engineering"}}
```

Merge `entries` must enumerate every service in the target and sources once, with non-negative `order`; optional `displayName` edits that service. The target keeps project identity and metadata. Split keeps the source project and moves one service to a distinct new project. Section matching is case-insensitive/trimmed; blank sections use the `fallback` key.

`displayEdit.projects` atomically edits display metadata on multiple existing projects. Each project uses a `key` scoped to the path owner, may provide a project `displayName`, and must include every canonical service exactly once in `services`, each with a unique non-negative `order`. A service `displayName` is optional; omitting it preserves the existing value. Omit the project `displayName` to preserve it. The request is one transaction and uses the same expected-revision conflict behavior as merge/split.

Success returns HTTP 200 with `{ "success": true, "data": { "action": "transaction", "changed": true, "revision": "...", "localCommit": {"status":"committed","revision":"..."}, "push": {"requested":false,"status":"not-requested"}, "written": [{"owner":"alice","name":"app"}], "removed": [] } }`. Invalid operations return 400 (`request.invalid`), stale revisions and name collisions return 409 (`projects.conflict`), missing projects/services return 404, and authorization failures return 403, using the standard `{success:false,error:{code,message,op,status,retryable,details}}` envelope.

Project and service `displayName` and service `order` are also writable with the existing `PATCH /api/v1/users/{owner}/projects/{name}` and returned by the existing project/list reads.
