import { describe, expect, test } from "bun:test"
import { devUnitName } from "./devUnitName.js"

describe("devUnitName", () => {
  test("derives a deterministic unit name per user and project", () => {
    expect(devUnitName({ user: "tim", project: "akademie" })).toEqual({
      success: true,
      data: "dev-tim-akademie.service",
    })
  })

  test("suffixes the service name for multi-service projects", () => {
    expect(devUnitName({ user: "tim", project: "akademie", serviceId: "api" })).toEqual({
      success: true,
      data: "dev-tim-akademie--api.service",
    })
  })

  test("rejects unsafe names that could escape the unit namespace", () => {
    for (const options of [
      { user: "../root", project: "akademie" },
      { user: "tim", project: "../etc" },
      { user: "tim", project: "akademie", serviceId: "../../x" },
    ]) {
      expect(devUnitName(options).success).toBe(false)
    }
  })
})
