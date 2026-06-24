// Claude-import ledger — the source of truth for idempotency and teardown.
// One JSON file in Global.Path.data, dedup keyed on the Claude session UUID
// (the .jsonl filename). We dedup on UUID rather than a content hash on purpose:
// Claude session files grow as the user continues the conversation, so a hash
// treats every continuation as a brand-new session (codex has this bug). UUID
// matches one session forever.

import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"

export type LedgerRecord = {
  claudeSessionID: string
  sourcePath: string
  opencodeSessionID: string
  directory: string
  importedAt: number
  lineCount: number
}

export type Ledger = { records: LedgerRecord[] }

export function ledgerPath(): string {
  return path.join(Global.Path.data, "claude-import-ledger.json")
}

export function read(): Ledger {
  const p = ledgerPath()
  if (!fs.existsSync(p)) return { records: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"))
    if (!parsed || !Array.isArray(parsed.records)) return { records: [] }
    return parsed as Ledger
  } catch {
    return { records: [] }
  }
}

export function write(data: Ledger): void {
  const p = ledgerPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}

export function findByClaudeID(claudeSessionID: string): LedgerRecord | undefined {
  return read().records.find((r) => r.claudeSessionID === claudeSessionID)
}

export function findByOpencodeID(opencodeSessionID: string): LedgerRecord | undefined {
  return read().records.find((r) => r.opencodeSessionID === opencodeSessionID)
}

export function append(record: LedgerRecord): void {
  const data = read()
  data.records.push(record)
  write(data)
}

export function removeByOpencodeID(opencodeSessionID: string): boolean {
  const data = read()
  const next = data.records.filter((r) => r.opencodeSessionID !== opencodeSessionID)
  if (next.length === data.records.length) return false
  write({ records: next })
  return true
}
