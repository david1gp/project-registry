import { resolve } from "node:path"
import * as a from "valibot"

const pathSchema = a.pipe(
  a.string(),
  a.minLength(2, "path must not be the filesystem root"),
  a.check(
    (path) => path.startsWith("/") && resolve(path) === path && !path.includes("\0"),
    "path must be absolute and normalized",
  ),
)

export const localDomainsOptionsSchema = a.strictObject({
  mkcertBinary: pathSchema,
  stateDirectory: pathSchema,
  hostsFilePath: a.pipe(
    pathSchema,
    a.check((path) => path !== "/etc" && !path.startsWith("/etc/"), "hosts output must not be in /etc"),
  ),
})

export type LocalDomainsOptions = a.InferOutput<typeof localDomainsOptionsSchema>
