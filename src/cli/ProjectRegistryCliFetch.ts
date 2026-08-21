export type ProjectRegistryCliFetch = (
  input: string | URL | Request,
  init?: RequestInit & { unix?: string },
) => Promise<Response>
