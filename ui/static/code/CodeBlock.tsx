import type { Component, ComponentProps } from "solid-js"
import { splitProps } from "solid-js"
import { classMerge } from "#ui/utils/classMerge.js"

export interface CodeBlockProps extends ComponentProps<"pre"> {
  data: string | object | unknown[]
}

/** Preformatted block rendering text or JSON data. */
export const CodeBlock: Component<CodeBlockProps> = (p) => {
  const [s, rest] = splitProps(p, ["class", "data"])
  return (
    <pre
      class={classMerge(
        "p-2 rounded-lg text-sm whitespace-pre-wrap wrap-anywhere bg-slate-100 dark:bg-slate-900",
        s.class,
      )}
      {...rest}
    >
      {getCodeContent(s.data)}
    </pre>
  )
}

function getCodeContent(data: CodeBlockProps["data"]): string {
  if (typeof data === "string") return data
  return JSON.stringify(data, null, 2)
}
