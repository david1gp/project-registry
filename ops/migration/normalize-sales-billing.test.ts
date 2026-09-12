import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const directories: string[] = []

async function runScript(cli: string, log: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(
    [
      "bash",
      new URL("./normalize-sales-billing.bash", import.meta.url).pathname,
      "--apply",
      "--cli",
      cli,
      "--socket",
      "/run/test.sock",
    ],
    {
      env: { ...Bun.env, LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stdout, stderr }
}

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
})

describe("normalize-sales-billing.bash", () => {
  test("skips grouped records that are already removed", async () => {
    const directory = await mkdtemp(join(Bun.env.TMPDIR ?? "/tmp", "normalize-sales-billing-"))
    directories.push(directory)
    const cli = join(directory, "fake-cli")
    const log = join(directory, "calls.log")
    await writeFile(
      cli,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LOG"
if [[ "$1" == "project" && "$2" == "get" ]]; then
  case "$3" in
    sales-api|sales-web-preview|sales-web-prod|billing-preview)
      printf '%s\n' '{"success":false,"error":{"code":"projects.not-found","status":404}}' >&2
      exit 1
      ;;
  esac
  printf '%s\n' '{"success":true,"data":{}}'
  exit 0
fi
`,
      "utf8",
    )
    await chmod(cli, 0o755)

    const result = await runScript(cli, log)

    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.stdout).toContain("skip missing project: sales-api")
    const calls = (await Bun.file(log).text()).split("\n").filter((line) => line !== "")
    expect(calls).toEqual([
      "project get sales --json --socket /run/test.sock",
      "project edit sales --type internal --label section=Interne --socket /run/test.sock",
      "project get sales-api --json --socket /run/test.sock",
      "project get sales-web-preview --json --socket /run/test.sock",
      "project get sales-web-prod --json --socket /run/test.sock",
      "project get billing --json --socket /run/test.sock",
      "project edit billing --type internal --label section=Interne --socket /run/test.sock",
      "project get billing-preview --json --socket /run/test.sock",
      "project get akademie --json --socket /run/test.sock",
      "project edit akademie --type own --label section=Eigene --socket /run/test.sock",
      "project get akademie-api --json --socket /run/test.sock",
      "project edit akademie-api --type own --label section=Eigene --socket /run/test.sock",
      "project get akademie-dev-api --json --socket /run/test.sock",
      "project edit akademie-dev-api --type own --label section=Eigene --socket /run/test.sock",
      "project get akademie-prod --json --socket /run/test.sock",
      "project edit akademie-prod --type own --label section=Eigene --socket /run/test.sock",
    ])
  })
})
