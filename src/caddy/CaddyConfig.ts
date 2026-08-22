export type CaddyConfig = {
  apps: {
    http: {
      servers: {
        srv0: {
          listen: string[]
          routes: unknown[]
          logs?: {
            logger_names: Record<string, string[]>
            should_log_credentials: boolean
          }
        }
      }
    }
    oidc?: {
      providers: Record<
        string,
        {
          issuer: string
          client_id: string
          client_secret: string
          scope: string[]
          username: string
          authenticators: {
            authenticators: Array<{
              authenticator: string
              name: string
              secret: string
              max_age: string
              redirect_url: string
            }>
          }
        }
      >
    }
  }
  logging?: {
    logs: Record<string, unknown>
  }
}
