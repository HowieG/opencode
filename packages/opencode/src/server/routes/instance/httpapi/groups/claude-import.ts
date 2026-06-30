// HttpApi group for the Claude Code → opencode conversation importer.
//
// Surface (project-agnostic — the writer files each session under the opencode
// project for its recorded cwd, NOT under the caller's current project):
//   GET    /import/claude/sessions                       — list available .jsonl files + import status
//   POST   /import/claude/sessions/:claudeSessionID      — import one
//   DELETE /import/claude/sessions/:claudeSessionID      — teardown a previously imported session
//
// No InstanceContext or workspace-routing middleware: every imported session
// is routed by its own .jsonl cwd, so this surface doesn't need the caller's
// current project. Only Authorization is applied.

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/import/claude"

const ImportedInfo = Schema.Struct({
  opencodeSessionID: Schema.String,
  importedAt: Schema.Number,
  lineCount: Schema.Number,
  /** True when the source .jsonl has grown since the import (continuation happened). */
  sourceChanged: Schema.Boolean,
})

export const SessionStatus = Schema.Struct({
  claudeSessionID: Schema.String,
  sourcePath: Schema.String,
  /** The raw cwd recorded in the .jsonl. */
  directory: Schema.String,
  /** The opencode project worktree the cwd resolves to (after git collapse). Same as `directory` for non-git cwds. */
  projectWorktree: Schema.String,
  title: Schema.String,
  lineCount: Schema.Number,
  mtime: Schema.Number,
  imported: Schema.optional(ImportedInfo),
}).annotate({ identifier: "ClaudeImport.SessionStatus" })

const ImportResultSuccess = Schema.Struct({
  status: Schema.Literal("imported"),
  opencodeSessionID: Schema.String,
  title: Schema.String,
  /** The source cwd (.jsonl's recorded directory). */
  directory: Schema.String,
  /** The opencode project worktree the session was filed under — used by the UI to register it in the sidebar. */
  projectWorktree: Schema.String,
  importedTurns: Schema.Number,
  skippedToolOnly: Schema.Number,
})

const ImportResultSkipped = Schema.Struct({
  status: Schema.Literal("already-imported"),
  opencodeSessionID: Schema.String,
  lineCount: Schema.Number,
  sourceLineCount: Schema.Number,
})

export const ImportResult = Schema.Union([ImportResultSuccess, ImportResultSkipped]).annotate({
  identifier: "ClaudeImport.ImportResult",
})

export const TeardownResult = Schema.Struct({
  removed: Schema.Boolean,
  opencodeSessionID: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ClaudeImport.TeardownResult" })

export const ClaudeImportPaths = {
  list: `${root}/sessions`,
  import: `${root}/sessions/:claudeSessionID`,
  teardown: `${root}/sessions/:claudeSessionID`,
} as const

export const ClaudeImportApi = HttpApi.make("claude-import")
  .add(
    HttpApiGroup.make("claude-import")
      .add(
        HttpApiEndpoint.get("list", ClaudeImportPaths.list, {
          success: described(Schema.Array(SessionStatus), "List of discovered Claude sessions with import status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "claudeImport.list",
            summary: "List Claude sessions available to import",
            description:
              "Scan ~/.claude/projects for conversation files, join with the import ledger, and return one entry per session — newest first.",
          }),
        ),
        HttpApiEndpoint.post("import", ClaudeImportPaths.import, {
          params: { claudeSessionID: Schema.String },
          success: described(ImportResult, "Imported (or skipped if already imported)"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "claudeImport.import",
            summary: "Import a Claude session",
            description:
              "Parse the .jsonl identified by the Claude session UUID and write its text turns into opencode storage. Idempotent on the UUID.",
          }),
        ),
        HttpApiEndpoint.delete("teardown", ClaudeImportPaths.teardown, {
          params: { claudeSessionID: Schema.String },
          success: described(TeardownResult, "Teardown outcome"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "claudeImport.teardown",
            summary: "Remove an imported Claude session",
            description:
              "Delete the rows for a previously imported session (parts → messages → session) and clear its ledger entry.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "claude-import",
          description: "Import Claude Code conversation history into opencode storage.",
        }),
      )
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode claude-import HttpApi",
      version: "0.0.1",
      description: "Routes for the Claude Code conversation-history importer.",
    }),
  )
