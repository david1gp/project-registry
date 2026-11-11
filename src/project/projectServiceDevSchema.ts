import * as a from "valibot"
import {
  projectServiceDevCommandMaxLength,
  projectServiceDevCommandValidate,
} from "./projectServiceDevCommandValidate.js"

export const projectServiceDevSchema = a.strictObject({
  command: a.pipe(
    a.string(),
    a.minLength(1),
    a.maxLength(projectServiceDevCommandMaxLength),
    a.check(
      (command) => projectServiceDevCommandValidate(command).success,
      "dev command must tokenize to argv without shell metacharacters, unknown placeholders, or project-dir escapes",
    ),
  ),
})

export type ProjectServiceDev = a.InferOutput<typeof projectServiceDevSchema>
