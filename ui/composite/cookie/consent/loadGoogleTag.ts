import { ensureGtag } from "./ensureGtag.js"

const loadedGoogleScripts = new Set<string>()

/** Inject the gtag.js loader for a given id exactly once. */
export function loadGoogleTag(id: string): void {
  if (typeof document === "undefined" || !id || loadedGoogleScripts.has(id)) return
  if (Array.from(document.scripts).some((s) => s.src.includes(`id=${id}`))) {
    loadedGoogleScripts.add(id)
    return
  }

  ensureGtag()
  window.gtag?.("js", new Date())

  const script = document.createElement("script")
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`
  document.head.appendChild(script)
  loadedGoogleScripts.add(id)
}
