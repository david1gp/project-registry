/** Bootstrap `window.dataLayer` + `gtag` so consent calls can queue before gtag.js loads. */
export function ensureGtag(): void {
  if (typeof window === "undefined") return

  window.dataLayer = window.dataLayer ?? []
  window.gtag =
    window.gtag ??
    function gtag() {
      // gtag relies on the live `arguments` object being pushed onto the dataLayer.
      // biome-ignore lint/complexity/noArguments: required by the gtag.js contract
      window.dataLayer?.push(arguments)
    }
}
