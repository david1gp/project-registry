let count = 0

export function generateToastId() {
  count = (count + 1) % Number.MAX_VALUE
  return count.toFixed(0)
}
