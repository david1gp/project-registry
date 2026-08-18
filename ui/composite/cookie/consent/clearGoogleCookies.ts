const googleCookiePrefixes = ["_ga", "_gid", "_gat", "_gcl", "_gac"]

/** Best-effort removal of Google's first-party cookies after consent is withdrawn. */
export function clearGoogleCookies(): void {
  if (typeof document === "undefined") return

  const { hostname } = window.location
  const rootDomain = hostname.split(".").slice(-2).join(".")
  const domains = [undefined, hostname, `.${hostname}`, `.${rootDomain}`]

  for (const cookie of document.cookie.split(";")) {
    const name = cookie.trim().split("=")[0]
    if (!name || !googleCookiePrefixes.some((prefix) => name.startsWith(prefix))) continue

    for (const domain of domains) {
      // biome-ignore lint/suspicious/noDocumentCookie: clearing third-party cookies needs the classic API
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; path=/; SameSite=Lax${
        domain ? `; domain=${domain}` : ""
      }`
    }
  }
}
