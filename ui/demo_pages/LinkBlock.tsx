import { BulletLinks } from "#ui/interactive/list/BulletLinks.jsx"

export interface LinkBlockProps {
  header: string
  removeUrlPrefix: string
  links: string[]
}

export function LinkBlock(p: LinkBlockProps) {
  return (
    <>
      <h2 class={"text-xl font-semibold"}>{p.header}</h2>
      <div class={"flex flex-col"}>
        <BulletLinks internal removeUrlPrefix={p.removeUrlPrefix} urls={p.links} />
      </div>
    </>
  )
}
