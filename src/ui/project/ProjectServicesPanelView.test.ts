import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./ProjectServicesPanelView.tsx", import.meta.url)).text()

describe("ProjectServicesPanelView", () => {
  test("offers an add action even when the service list is empty", () => {
    expect(source).toContain("onClick={p.state.editorNewOpen}")
    expect(source).toContain("Dienst hinzufügen")
    expect(source.indexOf("onClick={p.state.editorNewOpen}")).toBeLessThan(
      source.indexOf("<Show when={p.state.empty()}"),
    )
  })

  test("shows required ID and domains with optional port in the new-service form", () => {
    expect(source).toContain("when={p.state.creating()}")
    expect(source).toContain('p.state.draftFieldSet("id", event.currentTarget.value)')
    expect(source).toContain('p.state.draftFieldSet("domains", event.currentTarget.value)')
    expect(source).toContain("leer = automatisch")
    expect(source).toContain('aria-label={p.state.creating() ? "Neuen Dienst hinzufügen"')
  })

  test("keeps the editor form mounted as draft fields change while editing or creating", () => {
    expect(source).toContain("<Show when={p.state.draft()}>")
    expect(source).not.toContain("<Show when={p.state.draft()} keyed>")
    for (const field of ["id", "port", "domains", "kind", "access", "path", "disabled", "docs", "spa", "browse"]) {
      expect(source).toContain(`draft().${field}`)
    }
  })
})
