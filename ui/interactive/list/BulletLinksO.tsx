import { splitProps } from "solid-js"
import { BulletLinks } from "#ui/interactive/list/BulletLinks.jsx"

export interface BulletLinksOProps {
  urlObject: Record<string, string>
  removeUrlPrefix?: string
  bulletClass?: string
  linkClass?: string
  itemClass?: string
}

/** Bullet link list variant that takes its links as an object. */
export function BulletLinksO(p: BulletLinksOProps) {
  const [s, rest] = splitProps(p, ["urlObject"])
  const names = Object.keys(s.urlObject)
  const urls = Object.values(s.urlObject)
  return <BulletLinks urls={urls} display={names} {...rest} />
}
