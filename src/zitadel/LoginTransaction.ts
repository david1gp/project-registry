export type LoginTransaction = {
  state: string
  nonce: string
  codeVerifier: string
  callbackUrl: string
  preAuthCookieHash: string
  expiresAt: number
}
