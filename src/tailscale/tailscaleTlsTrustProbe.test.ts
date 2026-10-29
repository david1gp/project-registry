import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:tls"
import { tailscaleTlsTrustProbeCreate } from "./tailscaleTlsTrustProbe.js"

// Test-only self-signed fixture for trusted.probe.test (CN + SAN), minted
// with openssl. The private key below never leaves this test file.
const fixtureCertificate = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgIUJOvEivqZVir0lN/3w6U6w46XBWcwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSdHJ1c3RlZC5wcm9iZS50ZXN0MB4XDTI2MTAyOTEzMDEx
MFoXDTM2MTAyNjEzMDExMFowHTEbMBkGA1UEAwwSdHJ1c3RlZC5wcm9iZS50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlS616lh6ZIm88KSBcRH/
y2UsMPc+XV8ep+j46LcnnAZjg2p9wN4HjoS5V0AheXjj9/WTjC41TZiQMY6fJ7x4
q6Oy2QAAmefmcRuxHN393KmA8XVlx0vFu5HlG+U25M/7v64ffwIiM96DghEnM1av
ll10Ubj6KZLCA9tC+iKZMACpj85ldzKUxwDjho7QBEkkJ3MVUxBezbKNkL0lyGZg
NTV1ixiFiPKxjQaxRy1yM1BDGq+Gv6sYOkKNSyZN+fNYcqhXh4Z2yhuE24lDEsdr
Gg3dkerOunV6w1B1PPcME9TYFhuHHoZ+7LdIF2+hpP0kSbAWQemMbuk5xU+voEGg
UwIDAQABo3IwcDAdBgNVHQ4EFgQUyxrbm6uezSRLTflxb8rF8KHla/AwHwYDVR0j
BBgwFoAUyxrbm6uezSRLTflxb8rF8KHla/AwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HREEFjAUghJ0cnVzdGVkLnByb2JlLnRlc3QwDQYJKoZIhvcNAQELBQADggEBAIvn
+oaD2QDnufPO+Z9H0gpruxDH7KaWR+1LnI2lpt7tNAu7w8/HEta14SMOHVyH8Zvk
b5RCnORTEGgGThcot5u0UhK6XFFoEgop2ba2F4arOZuEOwqr6f5Bm/MIHilwSoMZ
3FgOBvPVs4fMX9beDoOJe2R/CmhrttV5qCZYAhNcU9HtgIdPPt/5/79njuRC/Igz
aKHR42nnbhxSQyIW+f3L4FTonYvs+KlIy+QnTRVvRGVFQ6IV/DkvwlnpJsPdMM/9
a50wybwVvnrT42LLe1Ncy9UlfmRlbNgeGRJBaAX+jji7UuXjl33dK2DUlFnEbZI8
OhcaM28PaN09jps3Fmw=
-----END CERTIFICATE-----`

const fixtureKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCVLrXqWHpkibzw
pIFxEf/LZSww9z5dXx6n6PjotyecBmODan3A3geOhLlXQCF5eOP39ZOMLjVNmJAx
jp8nvHiro7LZAACZ5+ZxG7Ec3f3cqYDxdWXHS8W7keUb5Tbkz/u/rh9/AiIz3oOC
ESczVq+WXXRRuPopksID20L6IpkwAKmPzmV3MpTHAOOGjtAESSQncxVTEF7Nso2Q
vSXIZmA1NXWLGIWI8rGNBrFHLXIzUEMar4a/qxg6Qo1LJk3581hyqFeHhnbKG4Tb
iUMSx2saDd2R6s66dXrDUHU89wwT1NgWG4cehn7st0gXb6Gk/SRJsBZB6Yxu6TnF
T6+gQaBTAgMBAAECggEADpCIkCriis2WawQUjckiaRAlQq6QzHrh5PtuJFeQABVG
QpPzV7tq5MjOc4HpArwBEw9LFW+EIrbstPnl+JzXnHeXRBpSSgmwSjCtl6eQsP9s
0vtm3BCTax7w+EqQ6RaTzytHxerxEzv704dV2sGcKO5SJzxg/WK88GAdZ4sDMQK+
o0GsjhpRz3wqERlKcN7SINQuW6Ybm6nzRh8G5aKo27SGuL3uAgdXvUx09IQCU75G
AD/f/5hlojO5WliR0QQKNmwRsUySYUxdo18qqs3SYtUXnQFL1c1qbCAoR+qyzbDt
Yp9qjxQDTlmORUfrYo9hFrOR92KvV+YXFYUUQTlBAQKBgQDQiGeq9Zp6YDj+V29a
r6cGYCGCLqyLr6+6C2y4D9io508ZO2R98B86C8kjnKR5BxXJVA9sTxDItzICyUb2
XdAgexQYvu/sc6pPEHMGsarvBgk9MEyzggNG9zr5TkcfWa+OvNTVwCkg6jjYPxYn
M2KOzqOMvp11iILIJ3pYSujO0wKBgQC3I9l8Z9iF++aTEnl1zeT14COwTZ8+Qsxc
eTt5yngk3WpI15sc+kAvNP/Y353x8Neew7x8x60iDKw9SM6tlQxS0oE8V22Rt9Z3
OIlYImihV3uxaJVB0DIR6dQXP/ZoV/9d7p3GYYeCbm8nnpfyq1JW0jSPlTj2RKW6
Rxj7Kff4gQKBgQCUyT5uVF6sAguoLWpeIgXiHqTJ5dNmtyuCarRff67ulFtzfVTu
Jm2hVNdmeVVApTV+OGPou2EWVN9x7XqcPcNJ6YclQNaetshFMU9g71Mux/e/mL6h
NZpw/+UsDBXi4HLKPSD+geTWf0efwyNjRN6FVhqLSVW/jm8BsGkypgAF0QKBgE/J
ho70jxiQTjv06IWyVfXo2KOOrbnqUC5ZgtfkpcMp04w4opNVU3E9ndlWUvF9A/Nf
Q1b5hyw2aTOp7KEjNmM+4p7vWAUMGpuGPg/vrbXc7z6zWZN6qNW1EXmvnCKJc+/w
bTxocSkaA8M3DOvkR9MbcVq8oDxqW+lz4CZMeoQBAoGAT80gpdSErrDao5Terzg1
ZBjx3PXdUqOpzFKUxt8flS864n9a8CihrWUswNFUP+b60lGIQaGpkGicOKI1Mt4z
afFdNnzG2MqgdlL9oJBLeAasQNB5fx/dYavOLnBE+i+Gfz+jKqCOnGTuX4Ms55lK
lD+cx0t9vokCcxB+erjjuz8=
-----END PRIVATE KEY-----`

async function serverListen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("test server has no address")
  return address.port
}

async function serverClose(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe("tailscaleTlsTrustProbeCreate", () => {
  test("trusts a verifiable chain and refuses anything else", async () => {
    const server = createServer({ cert: fixtureCertificate, key: fixtureKey })
    const port = await serverListen(server)
    try {
      const trustedR = tailscaleTlsTrustProbeCreate({ nodeAddress: "127.0.0.1", port, ca: fixtureCertificate })
      expect(trustedR.success).toBe(true)
      if (!trustedR.success) return
      const trusted = await trustedR.data.probe("trusted.probe.test")
      expect(trusted).toMatchObject({ success: true, data: "trusted" })

      const wrongName = await trustedR.data.probe("other.probe.test")
      expect(wrongName.success).toBe(false)

      const untrustedR = tailscaleTlsTrustProbeCreate({ nodeAddress: "127.0.0.1", port })
      expect(untrustedR.success).toBe(true)
      if (!untrustedR.success) return
      const untrusted = await untrustedR.data.probe("trusted.probe.test")
      expect(untrusted.success).toBe(false)
      if (untrusted.success) return
      expect(untrusted.errorMessage).toContain("trusted.probe.test")
      expect(untrusted.errorMessage).not.toContain("BEGIN CERTIFICATE")
    } finally {
      await serverClose(server)
    }
  })

  test("refuses unreachable nodes without leaking internals", async () => {
    const probeR = tailscaleTlsTrustProbeCreate({ nodeAddress: "127.0.0.1", port: 1, timeoutMs: 2_000 })
    expect(probeR.success).toBe(true)
    if (!probeR.success) return
    const probed = await probeR.data.probe("closed.probe.test")
    expect(probed.success).toBe(false)
    if (probed.success) return
    expect(probed.errorMessage).toContain("closed.probe.test")
  })

  test("rejects invalid node addresses, ports, and hostnames", () => {
    expect(tailscaleTlsTrustProbeCreate({ nodeAddress: "not-an-ip" }).success).toBe(false)
    expect(tailscaleTlsTrustProbeCreate({ nodeAddress: "::1" }).success).toBe(false)
    expect(tailscaleTlsTrustProbeCreate({ nodeAddress: "127.0.0.1", port: 0 }).success).toBe(false)
    expect(tailscaleTlsTrustProbeCreate({ nodeAddress: "127.0.0.1", timeoutMs: 0 }).success).toBe(false)

    const probeR = tailscaleTlsTrustProbeCreate({ nodeAddress: "127.0.0.1" })
    expect(probeR.success).toBe(true)
    if (!probeR.success) return
    expect(probeR.data.probe("")).resolves.toMatchObject({ success: false })
    expect(probeR.data.probe("127.0.0.1")).resolves.toMatchObject({ success: false })
  })
})
