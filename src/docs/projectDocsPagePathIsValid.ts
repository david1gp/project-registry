const docsPagePathPattern = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/
const reservedFirstComponentPattern = /^(?:index\.md|[a-f0-9]{64}\.(?:md|json)|page-[a-f0-9]{64}\.json)$/i

export function projectDocsPagePathIsValid(pagePath: unknown): pagePath is string {
  if (typeof pagePath !== "string" || pagePath.includes("..") || !docsPagePathPattern.test(pagePath)) return false
  return !reservedFirstComponentPattern.test(pagePath.split("/")[0] ?? "")
}
