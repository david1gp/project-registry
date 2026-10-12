export function wikiProjectNameNormalize(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}
