import { runCmdAsync } from "#utils/bun/runCmdAsync.js"

export async function formatGeneratedCodeFile(outputPath: string) {
  const cmd = `bun run biome check --write ${outputPath}`.split(" ")
  return runCmdAsync(cmd)
}
