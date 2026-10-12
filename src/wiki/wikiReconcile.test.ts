import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, symlink, writeFile, mkdir, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { wikiReconcile } from "./wikiReconcile.js"

function canonical(
  owner: string,
  name: string,
  labels: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) {
  return { schemaVersion: 2, owner, name, services: [], labels, ...extra }
}

function loggerCapture() {
  const messages: string[] = []
  return {
    messages,
    logger: {
      info: (message: string) => messages.push(`info: ${message}`),
      warn: (message: string) => messages.push(`warn: ${message}`),
    },
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "registry-wiki-"))
}

describe("wikiReconcile", () => {
  test("skips projects owned by someone other than leo without creating files", async () => {
    const root = await tempRoot()
    try {
      const capture = loggerCapture()
      const result = await wikiReconcile({
        root,
        projects: [canonical("david", "site", { section: "Kunden" })],
        logger: capture.logger,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(1)
      expect(result.data.created).toBe(0)
      await expect(readFile(join(root, "Projekte", "Externe", "site", "site.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("creates customer projects under Externe and other projects under Interne with Transcripte dirs", async () => {
    const root = await tempRoot()
    try {
      const capture = loggerCapture()
      const result = await wikiReconcile({
        root,
        projects: [
          canonical(
            "leo",
            "santuens",
            { section: "Kunden", customerName: "Santuens", customerEmail: "info@example.org" },
            { previewUrl: "https://preview.example", productionUrl: "https://santuens.example" },
          ),
          canonical("leo", "contentoren", { section: "Interne" }),
        ],
        logger: capture.logger,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ processed: 2, created: 2, skipped: 0 })

      const customerNote = join(root, "Projekte", "Externe", "santuens", "santuens.md")
      const customerRaw = await readFile(customerNote, "utf8")
      expect(customerRaw).toContain("projectRegistry:")
      expect(customerRaw).toContain("customerName: Santuens")
      expect(customerRaw).toContain("previewUrl: https://preview.example")
      expect(customerRaw).toContain("productionUrl: https://santuens.example")

      const internalNote = join(root, "Projekte", "Interne", "contentoren", "contentoren.md")
      await expect(readFile(internalNote, "utf8")).resolves.toContain("owner: leo")

      for (const dir of [
        join(root, "Projekte", "Externe", "santuens", "Transcripte"),
        join(root, "Projekte", "Interne", "contentoren", "Transcripte"),
      ]) {
        expect((await lstat(dir)).isDirectory()).toBe(true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reuses an existing case and separator variant without renaming folders or notes", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Externe", "NIKOLA CALIO")
      await mkdir(folder, { recursive: true })
      const note = join(folder, "NIKOLA CALIO.md")
      await writeFile(note, "# Nikola\n\nBody stays.\n", "utf8")

      const capture = loggerCapture()
      const result = await wikiReconcile({
        root,
        projects: [canonical("leo", "nikola-calio", { section: "Kunden", alternativeName: "Nikola_Calio" })],
        logger: capture.logger,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(0)
      const raw = await readFile(note, "utf8")
      expect(raw.endsWith("# Nikola\n\nBody stays.\n")).toBe(true)
      expect(raw).toContain("alternativeName: Nikola_Calio")
      await expect(
        readFile(join(root, "Projekte", "Externe", "Nikola_Calio", "Nikola_Calio.md"), "utf8"),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("resolves registry identity from frontmatter even when the folder spelling differs", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Interne", "OldSpelling")
      await mkdir(folder, { recursive: true })
      await writeFile(
        join(folder, "OldSpelling.md"),
        "---\nprojectRegistry:\n  schemaVersion: 2\n  owner: leo\n  name: santuens\n---\nOld body.\n",
        "utf8",
      )
      const result = await wikiReconcile({ root, projects: [canonical("leo", "santuens", { section: "Kunden" })] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.updated).toBe(1)
      const raw = await readFile(join(folder, "OldSpelling.md"), "utf8")
      expect(raw.endsWith("Old body.\n")).toBe(true)
      expect(raw).toContain("section: Kunden")
      await expect(readFile(join(root, "Projekte", "Externe", "santuens", "santuens.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves unknown frontmatter keys and the markdown body and is idempotent", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Interne", "contentoren")
      await mkdir(folder, { recursive: true })
      const note = join(folder, "contentoren.md")
      const before = "---\ncustomNote: keep-me\nsection: Stale\n---\n# Title\n\nExact body  \n"
      await writeFile(note, before, "utf8")

      const first = await wikiReconcile({ root, projects: [canonical("leo", "contentoren", { section: "Interne" })] })
      expect(first.success).toBe(true)
      if (!first.success) return
      expect(first.data.updated).toBe(1)

      const after = await readFile(note, "utf8")
      expect(after).toContain("customNote: keep-me")
      expect(after).toContain("section: Interne")
      expect(after.endsWith("# Title\n\nExact body  \n")).toBe(true)

      const second = await wikiReconcile({ root, projects: [canonical("leo", "contentoren", { section: "Interne" })] })
      expect(second.success).toBe(true)
      if (!second.success) return
      expect(second.data).toMatchObject({ unchanged: 1, created: 0, updated: 0 })
      expect(await readFile(note, "utf8")).toBe(after)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects unsafe project spellings without writing outside the wiki tree", async () => {
    const root = await tempRoot()
    try {
      const capture = loggerCapture()
      const result = await wikiReconcile({
        root,
        projects: [
          canonical("leo", "evil", { alternativeName: "../evil" }),
          canonical("leo", "slash", { alternativeName: "a/b" }),
        ],
        logger: capture.logger,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(2)
      expect(capture.messages.some((message) => message.includes("unsafe"))).toBe(true)
      await expect(readFile(join(root, "evil.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("skips symlinked notes instead of following them outside the tree", async () => {
    const root = await tempRoot()
    try {
      const outside = join(root, "outside.md")
      await writeFile(outside, "outside content\n", "utf8")
      const folder = join(root, "Projekte", "Interne", "linked")
      await mkdir(folder, { recursive: true })
      await symlink(outside, join(folder, "linked.md"))

      const capture = loggerCapture()
      const result = await wikiReconcile({ root, projects: [canonical("leo", "linked")], logger: capture.logger })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(1)
      expect(await readFile(outside, "utf8")).toBe("outside content\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("logs and skips ambiguous separator matches instead of creating duplicates", async () => {
    const root = await tempRoot()
    try {
      for (const folderName of ["Foo-Bar", "Foo_Bar"]) {
        const folder = join(root, "Projekte", "Interne", folderName)
        await mkdir(folder, { recursive: true })
        await writeFile(join(folder, `${folderName}.md`), `# ${folderName}\n`, "utf8")
      }
      const capture = loggerCapture()
      const result = await wikiReconcile({ root, projects: [canonical("leo", "foo-bar")], logger: capture.logger })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(1)
      expect(capture.messages.some((message) => message.includes("ambiguous"))).toBe(true)
      await expect(readFile(join(root, "Projekte", "Interne", "foo-bar", "foo-bar.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves pages for projects missing from the snapshot without deletes or renames", async () => {
    const root = await tempRoot()
    try {
      const note = join(root, "Projekte", "Externe", "gone", "gone.md")
      await mkdir(join(root, "Projekte", "Externe", "gone"), { recursive: true })
      const before = "---\nowner: leo\n---\nGone body.\n"
      await writeFile(note, before, "utf8")
      const result = await wikiReconcile({ root, projects: [] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ processed: 0, created: 0, updated: 0, skipped: 0 })
      expect(await readFile(note, "utf8")).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reuses a project nested under Externe/Archiv instead of creating an active duplicate", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Externe", "Archiv", "Intersolaris")
      await mkdir(folder, { recursive: true })
      const note = join(folder, "Intersolaris.md")
      await writeFile(
        note,
        "---\nprojectRegistry:\n  schemaVersion: 2\n  owner: leo\n  name: intersolaris\n---\nArchived body.\n",
        "utf8",
      )
      const capture = loggerCapture()
      const result = await wikiReconcile({
        root,
        projects: [canonical("leo", "intersolaris", { section: "Kunden" })],
        logger: capture.logger,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ processed: 1, updated: 1, created: 0, skipped: 0 })
      const raw = await readFile(note, "utf8")
      expect(raw.endsWith("Archived body.\n")).toBe(true)
      await expect(
        readFile(join(root, "Projekte", "Externe", "Intersolaris", "Intersolaris.md"), "utf8"),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("logs and skips when an archived identity and an active name both claim one project", async () => {
    const root = await tempRoot()
    try {
      const archivedFolder = join(root, "Projekte", "Externe", "Archiv", "Intersolaris")
      await mkdir(archivedFolder, { recursive: true })
      await writeFile(
        join(archivedFolder, "Intersolaris.md"),
        "---\nprojectRegistry:\n  schemaVersion: 2\n  owner: leo\n  name: intersolaris\n---\nArchived body.\n",
        "utf8",
      )
      const activeFolder = join(root, "Projekte", "Externe", "Intersolaris")
      await mkdir(activeFolder, { recursive: true })
      const activeNote = join(activeFolder, "Intersolaris.md")
      const activeBefore = "# Intersolaris\n\nActive body.\n"
      await writeFile(activeNote, activeBefore, "utf8")

      const capture = loggerCapture()
      const result = await wikiReconcile({
        root,
        projects: [canonical("leo", "intersolaris", { section: "Kunden" })],
        logger: capture.logger,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(1)
      expect(result.data.created).toBe(0)
      expect(result.data.updated).toBe(0)
      expect(capture.messages.some((message) => message.includes("ambiguous"))).toBe(true)
      expect(await readFile(activeNote, "utf8")).toBe(activeBefore)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("treats matching active and archived name spellings as ambiguous instead of picking one", async () => {
    const root = await tempRoot()
    try {
      const activeNote = join(root, "Projekte", "Externe", "Intersolaris", "Intersolaris.md")
      await mkdir(join(root, "Projekte", "Externe", "Intersolaris"), { recursive: true })
      const activeBefore = "# Intersolaris\n\nActive body.\n"
      await writeFile(activeNote, activeBefore, "utf8")
      const archivedNote = join(root, "Projekte", "Externe", "Archiv", "Intersolaris", "Intersolaris.md")
      await mkdir(join(root, "Projekte", "Externe", "Archiv", "Intersolaris"), { recursive: true })
      const archivedBefore = "# Intersolaris\n\nArchived body.\n"
      await writeFile(archivedNote, archivedBefore, "utf8")

      const result = await wikiReconcile({ root, projects: [canonical("leo", "intersolaris", { section: "Kunden" })] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ skipped: 1, created: 0, updated: 0 })
      expect(await readFile(activeNote, "utf8")).toBe(activeBefore)
      expect(await readFile(archivedNote, "utf8")).toBe(archivedBefore)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not treat the Archiv container itself as a project folder", async () => {
    const root = await tempRoot()
    try {
      const container = join(root, "Projekte", "Externe", "Archiv")
      await mkdir(container, { recursive: true })
      const result = await wikiReconcile({ root, projects: [canonical("leo", "archiv", { section: "Kunden" })] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ processed: 1, created: 1 })
      expect(await readFile(join(root, "Projekte", "Externe", "archiv", "archiv.md"), "utf8")).toContain("owner: leo")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reuses uppercase folder spellings without duplicating", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Externe", "SALES")
      await mkdir(folder, { recursive: true })
      const note = join(folder, "SALES.md")
      await writeFile(note, "# Sales\n\nBody stays.\n", "utf8")

      const result = await wikiReconcile({ root, projects: [canonical("leo", "sales", { section: "Kunden" })] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(0)
      expect((await readFile(note, "utf8")).endsWith("# Sales\n\nBody stays.\n")).toBe(true)
      await expect(readFile(join(root, "Projekte", "Externe", "sales", "sales.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("matches Unicode folder spellings across composed and decomposed forms", async () => {
    const root = await tempRoot()
    try {
      const folderSpelling = "Café X".normalize("NFD")
      const folder = join(root, "Projekte", "Externe", folderSpelling)
      await mkdir(folder, { recursive: true })
      const note = join(folder, `${folderSpelling}.md`)
      await writeFile(note, "# Cafe\n\nBody stays.\n", "utf8")

      const result = await wikiReconcile({
        root,
        projects: [canonical("leo", "cafe-x", { section: "Kunden", alternativeName: "Café_X" })],
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(0)
      expect((await readFile(note, "utf8")).endsWith("# Cafe\n\nBody stays.\n")).toBe(true)
      await expect(readFile(join(root, "Projekte", "Externe", "Café_X", "Café_X.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reuses a meaningful alias spelling instead of creating a duplicate folder", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Externe", "Aster-Immo")
      await mkdir(folder, { recursive: true })
      const note = join(folder, "Aster-Immo.md")
      await writeFile(note, "# Aster\n\nBody stays.\n", "utf8")

      const result = await wikiReconcile({
        root,
        projects: [canonical("leo", "aster-immobilien", { section: "Kunden", alternativeName: "Aster-Immo" })],
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(0)
      expect((await readFile(note, "utf8")).endsWith("# Aster\n\nBody stays.\n")).toBe(true)
      await expect(
        readFile(join(root, "Projekte", "Externe", "aster-immobilien", "aster-immobilien.md"), "utf8"),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("resolves registry identity from BOM-prefixed frontmatter without duplicating", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Interne", "OldSpelling")
      await mkdir(folder, { recursive: true })
      const note = join(folder, "OldSpelling.md")
      await writeFile(
        note,
        "\uFEFF---\nprojectRegistry:\n  schemaVersion: 2\n  owner: leo\n  name: santuens\n---\nOld body.\n",
        "utf8",
      )
      const result = await wikiReconcile({ root, projects: [canonical("leo", "santuens", { section: "Kunden" })] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.updated).toBe(1)
      const raw = await readFile(note, "utf8")
      expect(raw.endsWith("Old body.\n")).toBe(true)
      expect(raw.startsWith("\uFEFF")).toBe(false)
      await expect(readFile(join(root, "Projekte", "Externe", "santuens", "santuens.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("uses authoritative legacy URLs and lists service domains without guessing roles from domain strings", async () => {
    const root = await tempRoot()
    try {
      const services = [
        { id: "default", units: [], ownership: "registry", caddy: { port: 3135, domains: ["billing.contentoren.de"] } },
        {
          id: "billing-preview",
          units: [],
          ownership: "registry",
          caddy: { port: 3146, domains: ["preview.billing.contentoren.de"] },
        },
      ]
      const result = await wikiReconcile({
        root,
        projects: [
          canonical("leo", "billing", { section: "Interne" }, { services }),
          canonical(
            "leo",
            "coachingcompany",
            { section: "Kunden" },
            {
              previewUrl: "https://coachingcompany.leonardomora.de",
              productionUrl: "https://coachingcompany.pages.dev/",
              services: [
                {
                  id: "default",
                  units: [],
                  ownership: "registry",
                  caddy: { port: 3134, domains: ["coachingcompany.leonardomora.de"] },
                },
                {
                  id: "pages",
                  units: [],
                  ownership: "external",
                  caddy: { port: 3200, domains: ["coachingcompany.pages.dev"] },
                },
              ],
            },
          ),
        ],
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ created: 2, skipped: 0 })

      const billingRaw = await readFile(join(root, "Projekte", "Interne", "billing", "billing.md"), "utf8")
      expect(billingRaw).not.toContain("previewUrl:")
      expect(billingRaw).not.toContain("productionUrl:")
      expect(billingRaw).toContain("serviceDomains:")
      expect(billingRaw).toContain("billing.contentoren.de")
      expect(billingRaw).toContain("preview.billing.contentoren.de")

      const coachingRaw = await readFile(
        join(root, "Projekte", "Externe", "coachingcompany", "coachingcompany.md"),
        "utf8",
      )
      expect(coachingRaw).toContain("previewUrl: https://coachingcompany.leonardomora.de")
      expect(coachingRaw).toContain("productionUrl: https://coachingcompany.pages.dev/")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports unwritable project folders as observable skips without failing the run", async () => {
    const root = await tempRoot()
    const folder = join(root, "Projekte", "Externe", "locked")
    try {
      await mkdir(folder, { recursive: true })
      await chmod(folder, 0o555)
      const capture = loggerCapture()
      const result = await wikiReconcile({
        root,
        projects: [canonical("leo", "locked", { section: "Kunden" })],
        logger: capture.logger,
      })
      await chmod(folder, 0o755)
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ created: 0, skipped: 1 })
      expect(result.data.skippedMessages.length).toBe(1)
      expect(capture.messages.some((message) => message.includes("locked"))).toBe(true)
    } finally {
      await chmod(folder, 0o755).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  test("leaves a sole ancillary Links note untouched and creates the folder-named primary", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Externe", "Aster-Immo")
      await mkdir(folder, { recursive: true })
      const ancillary = join(folder, "Links.md")
      const before = "# Links\n\n- https://example.org\n"
      await writeFile(ancillary, before, "utf8")

      const result = await wikiReconcile({
        root,
        projects: [canonical("leo", "aster-immobilien", { section: "Kunden", alternativeName: "Aster-Immo" })],
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ created: 1, updated: 0, skipped: 0 })
      expect(await readFile(ancillary, "utf8")).toBe(before)
      const primaryRaw = await readFile(join(folder, "Aster-Immo.md"), "utf8")
      expect(primaryRaw).toContain("projectRegistry:")
      expect(primaryRaw).toContain("name: aster-immobilien")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("cleans a stamped Emails ancillary and creates the folder-named primary preserving body and custom keys", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Externe", "Semesterkur")
      await mkdir(folder, { recursive: true })
      const ancillary = join(folder, "Emails.md")
      const body = "# Emails\n\nHello  \n"
      await writeFile(
        ancillary,
        "---\nprojectRegistry:\n  schemaVersion: 2\n  owner: leo\n  name: semesterkur\nowner: leo\nname: semesterkur\nsection: Kunden\ncustomNote: keep-me\n---\n" +
          body,
        "utf8",
      )

      const result = await wikiReconcile({ root, projects: [canonical("leo", "semesterkur", { section: "Kunden" })] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ created: 1, skipped: 0 })

      const cleaned = await readFile(ancillary, "utf8")
      expect(cleaned.endsWith(body)).toBe(true)
      expect(cleaned).toContain("customNote: keep-me")
      expect(cleaned).not.toContain("projectRegistry")

      const primaryRaw = await readFile(join(folder, "Semesterkur.md"), "utf8")
      expect(primaryRaw).toContain("projectRegistry:")
      expect(primaryRaw).toContain("name: semesterkur")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("migrates a stamped archived 1.Rechnung note to the folder-named primary", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Externe", "Archiv", "Intersolaris")
      await mkdir(folder, { recursive: true })
      const ancillary = join(folder, "1.Rechnung.md")
      const body = "Rechnung body.\n"
      await writeFile(
        ancillary,
        "---\nprojectRegistry:\n  schemaVersion: 2\n  owner: leo\n  name: intersolaris\nowner: leo\nsection: Kunden\ncustomNote: keep-me\n---\n" +
          body,
        "utf8",
      )

      const result = await wikiReconcile({ root, projects: [canonical("leo", "intersolaris", { section: "Kunden" })] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data).toMatchObject({ created: 1, skipped: 0 })

      const cleaned = await readFile(ancillary, "utf8")
      expect(cleaned.endsWith(body)).toBe(true)
      expect(cleaned).toContain("customNote: keep-me")
      expect(cleaned).not.toContain("projectRegistry")

      const primaryRaw = await readFile(join(folder, "Intersolaris.md"), "utf8")
      expect(primaryRaw.endsWith("# Intersolaris\n")).toBe(true)
      expect(primaryRaw).toContain("name: intersolaris")
      await expect(
        readFile(join(root, "Projekte", "Externe", "Intersolaris", "Intersolaris.md"), "utf8"),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("coalesces multiple stamped notes in one folder instead of reporting ambiguity", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Externe", "Sales")
      await mkdir(folder, { recursive: true })
      const first = join(folder, "Konkurrenz_links.md")
      const second = join(folder, "Notes.md")
      const firstBody = "Links body.\n"
      const secondBody = "Notes body.\n"
      await writeFile(
        first,
        "---\nprojectRegistry:\n  schemaVersion: 2\n  owner: leo\n  name: sales\nowner: leo\n---\n" + firstBody,
        "utf8",
      )
      await writeFile(
        second,
        "---\nprojectRegistry:\n  schemaVersion: 2\n  owner: leo\n  name: sales\nsection: Kunden\n---\n" + secondBody,
        "utf8",
      )

      const capture = loggerCapture()
      const result = await wikiReconcile({
        root,
        projects: [canonical("leo", "sales", { section: "Kunden" })],
        logger: capture.logger,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(0)
      expect(result.data.created).toBe(1)
      expect(capture.messages.some((message) => message.includes("ambiguous"))).toBe(false)

      expect((await readFile(first, "utf8")).endsWith(firstBody)).toBe(true)
      expect(await readFile(first, "utf8")).not.toContain("projectRegistry")
      expect((await readFile(second, "utf8")).endsWith(secondBody)).toBe(true)
      expect(await readFile(second, "utf8")).not.toContain("projectRegistry")
      expect(await readFile(join(folder, "Sales.md"), "utf8")).toContain("name: sales")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reuses an exact uppercase primary note without duplicating", async () => {
    const root = await tempRoot()
    try {
      const folder = join(root, "Projekte", "Externe", "LEONARDO")
      await mkdir(folder, { recursive: true })
      const note = join(folder, "LEONARDO.md")
      await writeFile(note, "# Leonardo\n\nBody stays.\n", "utf8")

      const result = await wikiReconcile({ root, projects: [canonical("leo", "leonardo", { section: "Kunden" })] })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.skipped).toBe(0)
      expect((await readFile(note, "utf8")).endsWith("# Leonardo\n\nBody stays.\n")).toBe(true)
      await expect(readFile(join(root, "Projekte", "Externe", "leonardo", "leonardo.md"), "utf8")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
