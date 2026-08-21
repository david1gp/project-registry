import { describe, expect, test } from "bun:test"
import { projectRegistryCliSocketResolve } from "./projectRegistryCliSocketResolve.js"

describe("projectRegistryCliSocketResolve", () => {
  test("uses explicit, environment, then USER socket precedence", () => {
    expect(
      projectRegistryCliSocketResolve("/explicit.sock", {
        PROJECT_REGISTRY_SOCKET: "/environment.sock",
        USER: "david",
      }),
    ).toEqual({ success: true, data: "/explicit.sock" })
    expect(
      projectRegistryCliSocketResolve(undefined, { PROJECT_REGISTRY_SOCKET: "/environment.sock", USER: "david" }),
    ).toEqual({ success: true, data: "/environment.sock" })
    expect(projectRegistryCliSocketResolve(undefined, { USER: "david" })).toEqual({
      success: true,
      data: "/run/project-registry/david.sock",
    })
  })

  test.each([
    [{ PROJECT_REGISTRY_SOCKET: "", USER: "david" }, "PROJECT_REGISTRY_SOCKET must not be empty."],
    [{}, "USER is required to select the default project-registry socket."],
    [{ USER: "../root" }, "USER is not safe for a project-registry socket path."],
  ])("rejects unsafe fallback input", (environment, message) => {
    expect(projectRegistryCliSocketResolve(undefined, environment)).toMatchObject({
      success: false,
      op: "projectRegistryCliSocketResolve",
      errorMessage: message,
    })
  })
})
