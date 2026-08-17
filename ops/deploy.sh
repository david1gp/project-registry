#!/usr/bin/env bash
set -euo pipefail

echo "Running the local @adaptive-ds/project-registry deployment preflight."
bun run build
bun test
echo "Build and tests complete. Publish via: bun run release"
