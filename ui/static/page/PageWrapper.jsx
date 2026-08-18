import { classesBgGray } from "#ui/classes/classesBg.jsx";
import { classMerge } from "#ui/utils/classMerge.js";
/** Full-height page container with centered inner content. */
export function PageWrapper(p) {
    return (<div class={classMerge("min-h-dvh w-full", classesBgGray, p.class)}>
      <div class={classMerge("max-w-7xl mx-auto", "dark:text-white", "p-4", p.innerClass)}>{p.children}</div>
    </div>);
}
//# sourceMappingURL=PageWrapper.jsx.map