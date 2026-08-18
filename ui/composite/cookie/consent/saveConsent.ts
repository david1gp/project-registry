import { buildPreferences } from "./buildPreferences.js"
import { clearGoogleCookies } from "./clearGoogleCookies.js"
import { type ConsentConfig, defaultConsentConfig } from "./consentConfig.js"
import type { ConsentChoices, ConsentPreferences } from "./consentTypes.js"
import { initConsentMode } from "./initConsentMode.js"
import { updateConsentMode } from "./updateConsentMode.js"

/** Persist the user's choices, dispatch the change event, and sync Google Consent Mode. */
export function saveConsent(choices: ConsentChoices, config: ConsentConfig = defaultConsentConfig): ConsentPreferences {
  initConsentMode()

  const preferences = buildPreferences(choices)

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(config.storageKey, JSON.stringify(preferences))
    } catch {
      // storage unavailable (private mode / quota) — consent simply won't persist
    }
    window.dispatchEvent(new CustomEvent(config.changeEvent, { detail: preferences }))
  }

  updateConsentMode(choices)

  if (!choices.statistics && !choices.marketing) clearGoogleCookies()

  return preferences
}
