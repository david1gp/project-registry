import * as a from "valibot"
import {
  projectServiceDevCommandMaxLength,
  projectServiceDevCommandValidate,
} from "./projectServiceDevCommandValidate.js"
import { projectServiceEnvFileValidate } from "./projectServiceEnvFileValidate.js"
import { projectServiceManagedContainers } from "./projectServiceManagedContainers.js"

/**
 * Registry-managed permanent service (`proj-<project>-<service>.service`).
 * `command` uses the dev command grammar ({port}/{host} placeholders, argv
 * only); absent, the daemon derives it from package.json like `dev up`, on
 * the service's registered port. `envFile` is relative to the project dir.
 * `container: "podman"` runs `command` (`podman run …`) as a rootless
 * container of the service user; it needs an explicit command.
 */
export const projectServiceManagedSchema = a.pipe(
  a.strictObject({
    command: a.optional(
      a.pipe(
        a.string(),
        a.minLength(1),
        a.maxLength(projectServiceDevCommandMaxLength),
        a.check(
          (command) => projectServiceDevCommandValidate(command).success,
          "service command must tokenize to argv without shell metacharacters, unknown placeholders, or project-dir escapes",
        ),
      ),
    ),
    envFile: a.optional(
      a.pipe(
        a.string(),
        a.check(
          (envFile) => projectServiceEnvFileValidate(envFile).success,
          "service env file must be a relative path inside the project directory",
        ),
      ),
    ),
    container: a.optional(a.picklist(projectServiceManagedContainers)),
    autostart: a.boolean(),
  }),
  a.check(
    (managed) => managed.container === undefined || managed.command !== undefined,
    "container service needs an explicit service command (podman run …)",
  ),
)

export type ProjectServiceManaged = a.InferOutput<typeof projectServiceManagedSchema>
