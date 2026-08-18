import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { ImageType } from "./ImageType.js"
import { Img } from "./Img.js"

export interface TypedImgProps extends MayHaveClass {
  img: ImageType
  srcPrefix?: string
  zoomIn?: boolean
  invertColorsInDarkMode?: boolean
}

/** Renders an Img from a typed image object. */
export function TypedImg(p: TypedImgProps) {
  const isSvg = p.img.path.endsWith(".svg")
  return (
    <Img
      src={(p.srcPrefix ? p.srcPrefix : "") + p.img.path}
      alt={p.img.alt}
      invertColorsInDarkMode={p.invertColorsInDarkMode}
      class={p.class}
      width={isSvg ? undefined : p.img.width}
      height={isSvg ? undefined : p.img.height}
    />
  )
}
