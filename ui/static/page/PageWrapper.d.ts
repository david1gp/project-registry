import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js";
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js";
export interface PageWrapperProps extends MayHaveChildren, MayHaveClass {
    innerClass?: string;
}
/** Full-height page container with centered inner content. */
export declare function PageWrapper(p: PageWrapperProps): any;
//# sourceMappingURL=PageWrapper.d.ts.map