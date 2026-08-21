#!/usr/bin/env bun

import { projectRegistryCliRun } from "./cli/projectRegistryCliRun.js"

process.exitCode = await projectRegistryCliRun(Bun.argv.slice(2))
