export function projectDomainNormalize(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.+$/, "")
}
