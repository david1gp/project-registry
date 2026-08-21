import { useParams } from "@solidjs/router"

export function projectDetailPageStateCreate() {
  const params = useParams<{ owner: string; name: string }>()
  return { owner: () => params.owner, name: () => params.name }
}
