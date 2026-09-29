import { useSearchParams } from "@solidjs/router"

/** URL search-parameter accessor keeping the open service editor addressable and reloadable. */
export function projectServicesSearchParamsCreate() {
  const [searchParams, setSearchParams] = useSearchParams<{ service?: string; serviceNew?: string }>()
  return {
    get: (key: string) => {
      const value = searchParams[key as "service" | "serviceNew"]
      return typeof value === "string" && value !== "" ? value : undefined
    },
    set: (key: string, value?: string) => setSearchParams({ [key]: value ?? null }, { replace: true }),
  }
}
