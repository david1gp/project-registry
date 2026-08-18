import { consentModeFromChoices } from "./consentModeFromChoices.js"
import { ensureGtag } from "./ensureGtag.js"

let consentModeInitialized = false

/** Register the Consent Mode v2 defaults (everything denied). Call once on app start. */
export function initConsentMode(): void {
  if (typeof window === "undefined" || consentModeInitialized) return

  ensureGtag()
  window.gtag?.("consent", "default", consentModeFromChoices({ statistics: false, marketing: false }))
  consentModeInitialized = true
}
