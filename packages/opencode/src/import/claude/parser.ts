// Pure parser for Claude Code conversation files (~/.claude/projects/**/*.jsonl).
// No opencode dependencies — only stdlib + fs. The output is a canonical IR consumed
// by both the importer writer and the discovery preview path.
//
// Scope (per locked design decisions in PLAN.md): text turns only. Tool-only assistant
// turns are counted into `skippedToolOnly`. Subagent/meta lines are dropped entirely.

import fs from "fs"
import os from "os"
import path from "path"

export type ParsedTurn = {
  role: "user" | "assistant"
  text: string
  timestamp: number
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export type ParsedSession = {
  /** The Claude session UUID — the .jsonl filename without extension. The dedup key. */
  claudeSessionID: string
  /** Absolute path to the source .jsonl. */
  sourcePath: string
  /** The cwd recorded in the session (where the user was when Claude ran). */
  directory: string
  /** "[claude] " + first-user-turn preview. The visible marker in the sidebar. */
  title: string
  /** Total number of JSON lines in the source file (for ledger / change detection). */
  lineCount: number
  /** Conversational turns, in order, after applying the skip rules. */
  turns: ParsedTurn[]
  /** Assistant turns with no text (tool_use / thinking only), counted not stored. */
  skippedToolOnly: number
}

export type DiscoveryPreview = {
  claudeSessionID: string
  sourcePath: string
  directory: string
  title: string
  lineCount: number
  mtime: number
}

/** Root of Claude's per-project conversation store. */
export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects")
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text as string)
      .join("\n")
  return ""
}

function parseLines(raw: string): any[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean) as any[]
}

function deriveDirectory(lines: any[], sourcePath: string): string {
  const cwd = lines.find((l) => l.cwd)?.cwd
  if (cwd) return cwd
  // Fallback: reconstruct from the encoded project directory name Claude uses.
  return "/" + path.basename(path.dirname(sourcePath)).replace(/^-/, "").replace(/-/g, "/")
}

function deriveTitle(lines: any[], fallback: string): string {
  const firstUser = lines.find((l) => l.type === "user" && !l.isSidechain && !l.isMeta)
  const preview = textOf(firstUser?.message?.content).slice(0, 60).replace(/\n/g, " ")
  return "[claude] " + (preview || fallback)
}

/** Parse the full conversation file into the canonical IR used by the writer. */
export function parseSessionFile(sourcePath: string): ParsedSession {
  const claudeSessionID = path.basename(sourcePath).replace(/\.jsonl$/, "")
  const lines = parseLines(fs.readFileSync(sourcePath, "utf8"))
  const directory = deriveDirectory(lines, sourcePath)
  const title = deriveTitle(lines, claudeSessionID)

  const turns: ParsedTurn[] = []
  let skippedToolOnly = 0
  let lastUserSeen = false
  const now = Date.now()

  for (const line of lines) {
    if (line.isSidechain || line.isMeta) continue
    const ts = line.timestamp ? Date.parse(line.timestamp) : now

    if (line.type === "user") {
      const text = textOf(line.message?.content)
      if (!text.trim()) continue // tool_result-only user lines -> skip
      turns.push({
        role: "user",
        text,
        timestamp: ts,
        model: line.message?.model,
      })
      lastUserSeen = true
      continue
    }

    if (line.type === "assistant") {
      const text = textOf(line.message?.content)
      if (!text.trim()) {
        skippedToolOnly++
        continue
      }
      if (!lastUserSeen) continue // assistant with no preceding user -> skip
      const u = line.message?.usage || {}
      turns.push({
        role: "assistant",
        text,
        timestamp: ts,
        model: line.message?.model,
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        },
      })
    }
  }

  return {
    claudeSessionID,
    sourcePath,
    directory,
    title,
    lineCount: lines.length,
    turns,
    skippedToolOnly,
  }
}

/**
 * Cheap discovery preview — reads enough lines to derive title/directory but doesn't
 * fully parse the conversation. Used by GET /import/claude/sessions where dozens of
 * files may be listed at once.
 */
export function previewSessionFile(sourcePath: string): DiscoveryPreview {
  const claudeSessionID = path.basename(sourcePath).replace(/\.jsonl$/, "")
  const stat = fs.statSync(sourcePath)
  const raw = fs.readFileSync(sourcePath, "utf8")
  const lines = parseLines(raw)
  return {
    claudeSessionID,
    sourcePath,
    directory: deriveDirectory(lines, sourcePath),
    title: deriveTitle(lines, claudeSessionID),
    lineCount: lines.length,
    mtime: stat.mtimeMs,
  }
}
