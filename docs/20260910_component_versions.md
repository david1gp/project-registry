# Goal
Print deployed backend and local CLI/library versions through the CLI.

# Decisions
- Preserve existing offline `--version` behavior.
- Add `version` command with normal and JSON output using the configured backend connection.
- CLI and library share the package version; backend reports its running package version.
- Reuse existing dependencies and API conventions.

# Approach
Expose backend version metadata, connect the CLI command, and add focused tests before committing and deploying.

# Tasks
1. Implement version reporting and focused tests. Status: complete.
2. Run the commits skill via a fresh Luna subagent and push. Status: complete.
3. Deploy and verify version reporting via a fresh Luna subagent; check Leo's active CLI and update its Bun-global installation if needed. Status: complete.
