// Discovery — list Claude conversation files and join with the import ledger.
// Used by the CLI script (picks a default target) and the HTTP route (populates
// the importer modal). Newest first.

import fs from "fs"
import { execSync } from "child_process"
import { previewSessionFile, claudeProjectsRoot, type DiscoveryPreview } from "./parser"
import * as Ledger from "./ledger"

export type SessionStatus = DiscoveryPreview & {
  imported?: {
    opencodeSessionID: string
    importedAt: number
    lineCount: number
    /** True when the source .jsonl has grown since the import (continuation happened). */
    sourceChanged: boolean
  }
}

/** All Claude session files, sorted newest first. Excludes subagent transcripts. */
export function listClaudeSessionPaths(): string[] {
  const root = claudeProjectsRoot()
  if (!fs.existsSync(root)) return []
  const out = execSync(`find ${JSON.stringify(root)} -name '*.jsonl' -not -path '*/subagents/*'`, {
    encoding: "utf8",
  })
  return out
    .split("\n")
    .filter(Boolean)
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.f)
}

/** Full discovery list with previews + import status. Used by the modal. */
export function listSessions(): SessionStatus[] {
  const ledger = Ledger.read()
  const byID = new Map(ledger.records.map((r) => [r.claudeSessionID, r]))
  const out: SessionStatus[] = []
  for (const filePath of listClaudeSessionPaths()) {
    try {
      const preview = previewSessionFile(filePath)
      const rec = byID.get(preview.claudeSessionID)
      out.push({
        ...preview,
        imported: rec
          ? {
              opencodeSessionID: rec.opencodeSessionID,
              importedAt: rec.importedAt,
              lineCount: rec.lineCount,
              sourceChanged: rec.lineCount !== preview.lineCount,
            }
          : undefined,
      })
    } catch {
      // skip unreadable / malformed files silently — they shouldn't break the list
    }
  }
  return out
}

/** Look up the .jsonl path for a Claude session UUID. Returns null if not found. */
export function findSessionPath(claudeSessionID: string): string | null {
  for (const filePath of listClaudeSessionPaths()) {
    const id = filePath.split("/").pop()?.replace(/\.jsonl$/, "")
    if (id === claudeSessionID) return filePath
  }
  return null
}

/**
 * CLI default-target picker:
 *   undefined / no arg → second-to-last by mtime (stable test target; most recent is
 *                        usually the live session that keeps mutating)
 *   "--latest"        → most recent
 *   anything else     → returned as-is (treated as an explicit path)
 */
export function pickDefault(arg?: string): string | undefined {
  if (arg && arg !== "--latest") return arg
  const sessions = listClaudeSessionPaths()
  if (arg === "--latest") return sessions[0]
  return sessions[1] ?? sessions[0]
}
