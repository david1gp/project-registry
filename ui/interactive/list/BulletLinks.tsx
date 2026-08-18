import { LinkTextExternal, LinkTextInternal } from "#ui/interactive/link/LinkText.jsx"
import { BlueBulletPoint } from "#ui/static/lists/BlueBulletPoint.jsx"
import { classMerge } from "#ui/utils/classMerge.js"

export interface BulletLinksProps {
  urls: string[] | readonly string[]
  display?: string[] | readonly string[]
  onClick?: () => void
  removeUrlPrefix?: string
  bulletClass?: string
  linkClass?: string
  itemClass?: string
  internal?: boolean
}

/** Renders a list of links with blue bullet points. */
export function BulletLinks(p: BulletLinksProps) {
  return (
    <>
      {p.urls.map((url, i) => {
        const displayAs = p.display ? p.display[i] : p.removeUrlPrefix ? url.replace(p.removeUrlPrefix, "") : url
        return (
          <div class={classMerge("flex flex-row flex-nowrap content-center", p.itemClass)}>
            <BlueBulletPoint class={p.bulletClass} />
            {p.internal ? (
              <LinkTextInternal
                to="/$"
                params={{ _splat: url.replace(/^\//, "") }}
                class={classMerge(p.linkClass)}
                onClick={p.onClick}
              >
                {displayAs}
              </LinkTextInternal>
            ) : (
              <LinkTextExternal href={url} class={classMerge(p.linkClass)} onClick={p.onClick}>
                {displayAs}
              </LinkTextExternal>
            )}
          </div>
        )
      })}
    </>
  )
}
