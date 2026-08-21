import { posix } from "node:path"
import * as a from "valibot"

export const projectAccessLogRootSchema = a.pipe(
  a.string(),
  a.minLength(1, "access log root must not be empty"),
  a.check((value) => posix.isAbsolute(value), "access log root must be absolute"),
  a.check((value) => posix.normalize(value) === value, "access log root must be normalized"),
  a.check((value) => value !== "/", "access log root must not be the filesystem root"),
  a.check((value) => value === "/" || !value.endsWith("/"), "access log root must not have a trailing slash"),
  a.check((value) => !value.includes("\0"), "access log root must not contain NUL bytes"),
  a.check((value) => !value.includes("\n"), "access log root must not contain newlines"),
  a.check((value) => !value.includes("\\"), "access log root must not contain backslashes"),
)
