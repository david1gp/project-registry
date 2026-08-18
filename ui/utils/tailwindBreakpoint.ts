export type TailwindBreakpoint = keyof typeof tailwindBreakpoint

/**
 * https://tailwindcss.com/docs/responsive-design
 */
export const tailwindBreakpoint = {
  // sm - 640px = 40rem
  sm: "sm",

  // md - 768px = 48rem
  md: "md",

  // lg - 1024px = 64rem
  lg: "lg",

  // xl - 1280px = 80rem
  xl: "xl",

  // 2xl - 2560px = 160rem
  "2xl": "2xl",

  // 3xl - 3840px = 240rem
  "3xl": "3xl",
} as const

export const tailwindBreakpointW: Record<TailwindBreakpoint, string> = {
  sm: "40rem",
  md: "48rem",
  lg: "64rem",
  xl: "80rem",
  "2xl": "160rem",
  "3xl": "240rem",
} as const

/**
 * assume: 1 column = 200px
 * xs ~= 400-500
 * sm - 640px = 40rem -> 4 columns
 * md - 768px = 48rem -> 5 columns
 * lg - 1024px = 64rem -> 6 columns
 * xl - 1280px = 80rem -> 7 columns
 * https://tailwindcss.com/docs/responsive-design
 * @param columns - amount of columns
 * @param sm - amount of columns fit inside tailwind xs/sm (640px)
 * @param columnsStepSize - amount of columns fit inside an increase in tailwind breakpoint (around 200px)
 */
export function tableColumnAmountToTailwindBreakpoint(
  columns: number,
  sm = 3,
  columnsStepSize = 1,
): TailwindBreakpoint {
  const v = columns - sm
  if (v === columnsStepSize) return tailwindBreakpoint.md
  if (v === columnsStepSize * 2) return tailwindBreakpoint.lg
  if (v >= columnsStepSize * 3) return tailwindBreakpoint.xl
  return tailwindBreakpoint.sm
}
