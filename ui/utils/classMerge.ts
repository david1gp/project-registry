import { cn } from "cn"
import type { ClassValue } from "cn"

export function classMerge(...inputs: ClassValue[]) {
  return cn(...inputs)
}
