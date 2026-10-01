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

  test("uses the XDG runtime socket for the user-mode default", () => {
    expect(
      projectRegistryCliSocketResolve(undefined, {
        PROJECT_REGISTRY_MODE: "user",
        XDG_RUNTIME_DIR: "/run/user/1000/",
        USER: "david",
      }),
    ).toEqual({ success: true, data: "/run/user/1000/project-registry/david.sock" })
  })

  test.each([undefined, "", "relative/runtime"])(
    "rejects missing or relative XDG runtime only for the user-mode default (%s)",
    (runtimeDirectory) => {
      const environment = { XDG_RUNTIME_DIR: runtimeDirectory, USER: "david" }
      expect(projectRegistryCliSocketResolve(undefined, { ...environment, PROJECT_REGISTRY_MODE: "user" })).toMatchObject({
        success: false,
        op: "projectRegistryCliSocketResolve",
        errorMessage: "XDG_RUNTIME_DIR must be an absolute path in user mode.",
        hint: "Set XDG_RUNTIME_DIR to an absolute runtime directory or pass --socket <path>.",
      })
      expect(projectRegistryCliSocketResolve(undefined, environment)).toEqual({
        success: true,
        data: "/run/project-registry/david.sock",
      })
      expect(projectRegistryCliSocketResolve(undefined, { ...environment, PROJECT_REGISTRY_MODE: "root" })).toEqual({
        success: true,
        data: "/run/project-registry/david.sock",
      })
    },
  )

  test.each([undefined, "relative/runtime"])(
    "preserves explicit and environment socket precedence over invalid user-mode defaults (%s)",
    (runtimeDirectory) => {
      const environment = {
        PROJECT_REGISTRY_MODE: "user",
        XDG_RUNTIME_DIR: runtimeDirectory,
        PROJECT_REGISTRY_SOCKET: "/environment.sock",
      }
      expect(projectRegistryCliSocketResolve("/explicit.sock", environment)).toEqual({
        success: true,
        data: "/explicit.sock",
      })
      expect(projectRegistryCliSocketResolve(undefined, environment)).toEqual({
        success: true,
        data: "/environment.sock",
      })
      expect(projectRegistryCliSocketResolve("/explicit.sock", { ...environment, PROJECT_REGISTRY_SOCKET: "" })).toEqual({
        success: true,
        data: "/explicit.sock",
      })
    },
  )

  test.each([
    [
      { PROJECT_REGISTRY_SOCKET: "", USER: "david" },
      "PROJECT_REGISTRY_SOCKET must not be empty.",
      "Set PROJECT_REGISTRY_SOCKET to a Unix socket path or pass --socket <path>.",
    ],
    [{}, "USER is required to select the default project-registry socket.", "Set USER or pass --socket <path>."],
    [
      { USER: "../root" },
      "USER is not safe for a project-registry socket path.",
      "Use a valid Unix username in USER or pass --socket <path>.",
    ],
  ] as const)("rejects unsafe fallback input", (environment, message, hint) => {
    expect(projectRegistryCliSocketResolve(undefined, environment)).toMatchObject({
      success: false,
      op: "projectRegistryCliSocketResolve",
      errorMessage: message,
      hint,
    })
  })
})
