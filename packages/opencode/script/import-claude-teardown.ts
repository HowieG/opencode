#!/usr/bin/env bun
// Undo Claude Code imports recorded by script/import-claude.ts.
// Logic lives in @/import/claude/writer.ts so the HTTP DELETE route shares the implementation.
//
// Usage (run from packages/opencode; match the same DB env you imported with):
//   bun script/import-claude-teardown.ts            # remove ALL imported sessions in the ledger
//   bun script/import-claude-teardown.ts <id>       # remove one (Claude session UUID or opencode session id)

import { AppRuntime } from "@/effect/app-runtime"
import { ClaudeLedger, ClaudeWriter } from "@/import/claude"

const ledger = ClaudeLedger.read()
if (!ledger.records.length) {
  console.log("ledger empty — nothing to tear down")
  process.exit(0)
}

const arg = process.argv[2]
const targets = arg
  ? ledger.records.filter((r) => r.claudeSessionID === arg || r.opencodeSessionID === arg)
  : ledger.records.slice()

if (!targets.length) {
  console.log("no ledger entry matches: " + arg)
  process.exit(1)
}

console.log(`tearing down ${targets.length} imported session(s)`)

for (const r of targets) {
  const result = await AppRuntime.runPromise(ClaudeWriter.teardownSession(r.opencodeSessionID))
  if (result.removed) console.log(`  removed ${result.opencodeSessionID}  (${r.claudeSessionID})`)
  else console.log(`  skipped ${r.opencodeSessionID}  (${r.claudeSessionID}): ${result.reason}`)
}
const remaining = ClaudeLedger.read().records.length
console.log(`\ntore down ${targets.length} session(s); ${remaining} still in ledger`)

process.exit(0)
