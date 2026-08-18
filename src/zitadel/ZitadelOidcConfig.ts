export type ZitadelOidcConfig = {
  issuer: string
  clientId: string
  clientSecret?: string
  callbackUrl: string
  scope?: readonly string[]
  clockSkewSeconds?: number
  loginTransactionMaxAgeSeconds?: number
}
