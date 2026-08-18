import { type ConsentConfig, defaultConsentConfig } from "./consentConfig.js"
import { trackEvent } from "./trackEvent.js"

export function trackPageView(path?: string, config: ConsentConfig = defaultConsentConfig): boolean {
  const page = path ?? (typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined)
  return trackEvent(
    "page_view",
    {
      page_path: page,
      page_title: typeof document !== "undefined" ? document.title : undefined,
    },
    config,
  )
}
