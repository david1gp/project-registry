import { describe, expect, test } from "bun:test"
import { managedServicePasswdUserIdParse } from "./managedServicePasswdUserIdParse.js"

const passwd =
  "root:x:0:0:root:/root:/bin/bash\nprojectsx:x:1:1::/:/bin/false\nprojects:x:994:1007::/home/projects:/bin/bash\n"

describe("managedServicePasswdUserIdParse", () => {
  test("returns the exact user's uid, not a prefix match", () => {
    expect(managedServicePasswdUserIdParse(passwd, "projects")).toMatchObject({ success: true, data: 994 })
    expect(managedServicePasswdUserIdParse(passwd, "root")).toMatchObject({ success: true, data: 0 })
  })

  test("fails for a missing user or a malformed uid", () => {
    expect(managedServicePasswdUserIdParse(passwd, "nobody").success).toBe(false)
    expect(managedServicePasswdUserIdParse("projects:x:abc:1::/:/bin/sh", "projects").success).toBe(false)
  })
})
