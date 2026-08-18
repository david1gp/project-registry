import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface MayHaveChildrenAndClass extends MayHaveChildren, MayHaveClass {}
