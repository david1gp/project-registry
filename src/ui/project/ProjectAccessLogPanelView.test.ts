import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./ProjectAccessLogPanelView.tsx", import.meta.url)).text()

describe("ProjectAccessLogPanelView", () => {
  test("uses the shared busy state for both request actions", () => {
    expect(source).toContain("onClick={p.state.refresh} disabled={p.state.busy()}")
    expect(source).toContain("onClick={p.state.olderLoad} disabled={p.state.busy()}")
    expect(source).toContain("Erneut versuchen")
  })

  test("limits live updates to concise status text", () => {
    expect(source.match(/aria-live=/g)).toHaveLength(1)
    expect(source).toContain('<p class="sr-only" role="status" aria-live="polite">')
    expect(source).not.toMatch(/<div[^>]*aria-live=/)
  })

  test("labels the responsive table region with the unique panel title", () => {
    expect(source).toContain("<h2 id={p.titleId}")
    expect(source).toContain('<section class="overflow-x-auto" aria-labelledby={p.titleId}>')
  })

  test("offers the complete raw JSON record for inspection", () => {
    expect(source).toContain('import { CodeBlock } from "#ui/static/code/CodeBlock.jsx"')
    expect(source).toContain("<summary")
    expect(source).toContain("JSON anzeigen")
    expect(source).toContain("data={record}")
  })
})
