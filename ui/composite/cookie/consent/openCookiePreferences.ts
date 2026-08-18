import { type ConsentConfig, defaultConsentConfig } from "./consentConfig.js"

/** Dispatch the event the banner listens for to re-open its settings view. */
export function openCookiePreferences(config: ConsentConfig = defaultConsentConfig): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(config.preferencesEvent))
}
