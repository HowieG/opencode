#!/usr/bin/env bun
// Import a Claude Code session (.jsonl) into opencode's storage — conversation history (text turns).
// All logic lives in @/import/claude/* so the HTTP route handler shares it; this script is a wrapper.
//
// Usage (run from packages/opencode so the @/ alias resolves):
//   bun script/import-claude.ts                  # default: second-to-last Claude session (stable test target)
//   bun script/import-claude.ts --latest         # most recent Claude session (usually the live one)
//   bun script/import-claude.ts <path-to.jsonl>  # explicit session file
//
// The session is filed under the opencode Project for its recorded cwd (created on demand).
// Independent of any "current project" notion. No InstanceStore bootstrap needed.
//
// IMPORTANT (dev-clone DB landmine): a bun-run dev clone is InstallationChannel="local", so it targets
// opencode-local.db, NOT the installed app's opencode.db. To write the DB the real app reads, run with
// OPENCODE_DISABLE_CHANNEL_DB=1 (or OPENCODE_DB=/abs/path/to/opencode.db).

import fs from "fs"
import { AppRuntime } from "@/effect/app-runtime"
import { ClaudeParser, ClaudeDiscovery, ClaudeLedger, ClaudeWriter } from "@/import/claude"

const file = ClaudeDiscovery.pickDefault(process.argv[2])
if (!file || !fs.existsSync(file)) throw new Error("no session file found: " + file)

const parsed = ClaudeParser.parseSessionFile(file)

console.log("importing:", parsed.sourcePath)
console.log("session:  ", parsed.claudeSessionID)
console.log("directory:", parsed.directory)
console.log("title:    ", parsed.title)

const result = await AppRuntime.runPromise(ClaudeWriter.importSession(parsed))

if ("skipped" in result) {
  if (result.lineCount === result.sourceLineCount)
    console.log(
      `already imported: ${parsed.claudeSessionID} -> ${result.opencodeSessionID} (${result.lineCount} lines, unchanged)`,
    )
  else
    console.log(
      `already imported: ${parsed.claudeSessionID} -> ${result.opencodeSessionID} ` +
        `(was ${result.lineCount} lines, source now ${result.sourceLineCount}). ` +
        `Append/re-import is out of scope — run teardown first to re-import fresh.`,
    )
} else {
  console.log(`created session: ${result.opencodeSessionID}`)
  console.log(`\nimported ${result.importedTurns} text turns (skipped ${result.skippedToolOnly} tool-only assistant turns)`)
  console.log(`   session id: ${result.opencodeSessionID}`)
  console.log(`   ledger:     ${ClaudeLedger.ledgerPath()}`)
  console.log(`   open opencode in ${result.directory} and look for "${result.title}" in the sidebar`)
}

// AppRuntime keeps long-lived fibers (filewatcher/LSP/etc.) alive; force a clean exit.
process.exit(0)
