import { classMerge } from "#ui/utils/classMerge.js"
import { type ConsentConfig, resolveConsentConfig } from "./consent/consentConfig.js"
import { openCookiePreferences } from "./consent/openCookiePreferences.js"
import { defaultCookieBannerLabels } from "./cookieBannerLabels.js"

export interface CookieSettingsButtonProps {
  class?: string
  /** Button text. Defaults to the German "Cookie-Einstellungen". */
  children?: string
  /** Override storage key / event names so it targets the matching banner. */
  consentConfig?: Partial<ConsentConfig>
}

/** Small text button to re-open the cookie settings (e.g. in a footer). */
export function CookieSettingsButton(p: CookieSettingsButtonProps) {
  return (
    <button
      type="button"
      onClick={() => openCookiePreferences(resolveConsentConfig(p.consentConfig))}
      class={classMerge(
        "cursor-pointer text-sm text-slate-500 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
        p.class,
      )}
    >
      {p.children ?? defaultCookieBannerLabels.settingsButton}
    </button>
  )
}
