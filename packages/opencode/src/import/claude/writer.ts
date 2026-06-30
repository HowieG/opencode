// Effect program that imports a ParsedSession into opencode's storage.
//
// Why this isn't using Session.Service.updateMessage / updatePart / remove:
// those methods only publish events that a separate durable projector persists
// later. In a short-lived script (or a route handler that returns after the
// effect completes) that pipeline is racey. So — mirroring opencode's shipped
// cli/cmd/import.ts — we insert rows synchronously via Drizzle, validating each
// row through opencode's own SessionV1 / Session.Info schemas so any drift blows
// up loudly at import time.
//
// The live turn pipeline reads V1 MessageTable + PartTable (verified in
// STEP1-API-MAP.md §3), so V1-only writes are sufficient for continuation.

import path from "path"
import { createHash } from "crypto"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Slug } from "@opencode-ai/core/util/slug"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Project } from "@/project/project"
import type { ParsedSession } from "./parser"
import * as Ledger from "./ledger"

/**
 * Deterministic 40-char hex id keyed on the cwd. Used as a fallback for cwds
 * with no git context (which Project.Service.fromDirectory would collapse
 * into the single "global" project — we want them as distinct sidebar entries).
 */
function projectIdForCwd(cwd: string): string {
  return createHash("sha1").update("claude-import:" + cwd).digest("hex")
}

export type ImportResult = {
  opencodeSessionID: string
  title: string
  /** The conversation's recorded cwd (source). */
  directory: string
  /** The opencode project worktree the session was filed under — what the sidebar opens. */
  projectWorktree: string
  importedTurns: number
  skippedToolOnly: number
}

export type ImportSkipped = {
  skipped: true
  reason: "already-imported"
  opencodeSessionID: string
  lineCount: number
  sourceLineCount: number
}

export type ImportOutcome = ImportResult | ImportSkipped

const DEFAULT_PROVIDER = "anthropic"
const DEFAULT_MODEL = "claude-opus-4-8" // historical id; mapped to a current model at continuation if needed

const decodeMessage = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

/**
 * Import one parsed Claude session. Idempotent on the Claude session UUID.
 * Requires Database.Service + Project.Service in the effect context.
 *
 * Project resolution (hybrid):
 *  - Git-tracked cwd → use Project.Service.fromDirectory so opencode's normal
 *    git-aware logic collapses sibling worktrees (e.g. conductor workspaces of
 *    open-memory) into a single project.
 *  - No git → fall back to a deterministic per-cwd project row, so naked dirs
 *    don't all merge into the single "global" bucket.
 */
export const importSession = (parsed: ParsedSession) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const project = yield* Project.Service

    const existing = Ledger.findByClaudeID(parsed.claudeSessionID)
    if (existing) {
      return {
        skipped: true,
        reason: "already-imported" as const,
        opencodeSessionID: existing.opencodeSessionID,
        lineCount: existing.lineCount,
        sourceLineCount: parsed.lineCount,
      } satisfies ImportOutcome
    }

    const sessionID = SessionID.descending()
    const now = Date.now()

    // Resolve the project for this cwd.
    let projectID: string
    let projectWorktree: string
    const resolved = yield* project.fromDirectory(parsed.directory).pipe(
      Effect.map((r) => ({ ok: true as const, value: r })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    )
    if (resolved.ok && resolved.value.project.vcs) {
      // Git-tracked: trust opencode's resolution (collapses worktrees + monorepo siblings).
      projectID = resolved.value.project.id
      projectWorktree = resolved.value.project.worktree
    } else {
      // No git context — create a per-cwd project so distinct naked dirs stay separate.
      projectID = projectIdForCwd(parsed.directory)
      projectWorktree = parsed.directory
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID as never,
          worktree: projectWorktree as never,
          vcs: null,
          sandboxes: [projectWorktree] as never,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }

    const info = Schema.decodeUnknownSync(Session.Info)({
      id: sessionID,
      slug: Slug.create(),
      projectID,
      directory: parsed.directory,
      path: path.relative(path.resolve(projectWorktree), parsed.directory).replaceAll("\\", "/") || ".",
      title: parsed.title,
      version: InstallationVersion,
      time: { created: now, updated: now },
    }) as Session.Info

    yield* db
      .insert(SessionTable)
      .values(Session.toRow(info))
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    let lastUserID: string | undefined
    let imported = 0

    for (const turn of parsed.turns) {
      const id = MessageID.ascending()

      if (turn.role === "user") {
        const msg = decodeMessage({
          id,
          sessionID,
          role: "user",
          time: { created: turn.timestamp },
          agent: "build",
          model: { providerID: DEFAULT_PROVIDER, modelID: turn.model || DEFAULT_MODEL },
        }) as SessionV1.Info
        yield* insertMessage(db, sessionID, msg)
        yield* insertTextPart(db, sessionID, id, turn.text)
        lastUserID = id
        imported++
        continue
      }

      // assistant
      if (!lastUserID) continue // safety: parser already guarantees this, but be defensive
      const u = turn.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const msg = decodeMessage({
        id,
        sessionID,
        role: "assistant",
        time: { created: turn.timestamp, completed: turn.timestamp },
        parentID: lastUserID,
        modelID: turn.model || DEFAULT_MODEL,
        providerID: DEFAULT_PROVIDER,
        mode: "build",
        agent: "build",
        path: { cwd: parsed.directory, root: projectWorktree },
        cost: 0,
        tokens: {
          input: u.input,
          output: u.output,
          reasoning: 0,
          cache: { read: u.cacheRead, write: u.cacheWrite },
        },
      }) as SessionV1.Info
      yield* insertMessage(db, sessionID, msg)
      yield* insertTextPart(db, sessionID, id, turn.text)
      imported++
    }

    Ledger.append({
      claudeSessionID: parsed.claudeSessionID,
      sourcePath: parsed.sourcePath,
      opencodeSessionID: sessionID,
      directory: parsed.directory,
      importedAt: now,
      lineCount: parsed.lineCount,
    })

    return {
      opencodeSessionID: sessionID,
      title: parsed.title,
      directory: parsed.directory,
      projectWorktree,
      importedTurns: imported,
      skippedToolOnly: parsed.skippedToolOnly,
    } satisfies ImportOutcome
  })

/**
 * Delete a previously imported session and clear its ledger entry. Idempotent:
 * if the session row is already gone we still clear the ledger. Identifies the
 * target by either the Claude session UUID or the opencode session id.
 *
 * Row deletes are explicit (parts → messages → session) — FK CASCADE makes the
 * child deletes redundant when foreign_keys=ON, but explicit deletes are bulletproof
 * across PRAGMA states and surface zero-row deletes the same way.
 */
export const teardownSession = (id: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    // Resolve id (accept either Claude UUID or opencode session id)
    const rec =
      Ledger.findByClaudeID(id) ?? Ledger.findByOpencodeID(id) ?? null
    if (!rec) {
      return { removed: false, reason: "not-in-ledger" as const, opencodeSessionID: null }
    }

    const sid = rec.opencodeSessionID as never
    yield* db.delete(PartTable).where(eq(PartTable.session_id, sid)).run().pipe(Effect.orDie)
    yield* db.delete(MessageTable).where(eq(MessageTable.session_id, sid)).run().pipe(Effect.orDie)
    yield* db.delete(SessionTable).where(eq(SessionTable.id, sid)).run().pipe(Effect.orDie)

    Ledger.removeByOpencodeID(rec.opencodeSessionID)

    return { removed: true, reason: null, opencodeSessionID: rec.opencodeSessionID }
  })

// --- helpers: mirror cli/cmd/import.ts row shaping (data = info minus the columnized id keys) ---

function insertMessage(db: Database.Interface["db"], sessionID: string, msg: SessionV1.Info) {
  const { id, sessionID: _s, ...data } = msg
  return db
    .insert(MessageTable)
    .values({ id, session_id: sessionID as never, time_created: msg.time.created, data: data as never })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
}

function insertTextPart(db: Database.Interface["db"], sessionID: string, messageID: string, text: string) {
  const part = decodePart({ id: PartID.ascending(), sessionID, messageID, type: "text", text })
  const { id, sessionID: _s, messageID: _m, ...data } = part
  return db
    .insert(PartTable)
    .values({ id, message_id: messageID as never, session_id: sessionID as never, data: data as never })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
}
