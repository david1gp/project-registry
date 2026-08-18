import { consentModeFromChoices } from "./consentModeFromChoices.js"
import type { ConsentChoices } from "./consentTypes.js"
import { ensureGtag } from "./ensureGtag.js"

/** Push a Consent Mode v2 update reflecting the latest choices. */
export function updateConsentMode(choices: ConsentChoices): void {
  if (typeof window === "undefined") return

  ensureGtag()
  window.gtag?.("consent", "update", consentModeFromChoices(choices))
}
